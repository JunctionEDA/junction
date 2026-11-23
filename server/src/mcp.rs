//! The MCP endpoint: `POST /mcp` (Streamable HTTP), where an AI assistant (any model or service that speaks MCP) works on a person's online
//! projects.
//!
//! A tool call here does what the design assistant in the web editor does (web/domains/pcb/ai), with the
//! same tool definitions and the same code: the assistant's tool list (web/domains/pcb/ai/tools.json) is
//! the base of the catalog, and the calls are run by the same modules in a headless editor
//! (mcp_host.rs, web/domains/pcb/mcp/host.ts) that has the document open over the collaboration socket.
//! An edit therefore travels the ordinary op pipeline and appears live for everybody in the
//! document.  The one difference from the assistant is deliberate: in the editor a person
//! accepts a proposal card, here the person approves the tool call in their own AI client, so
//! `apply_changes` applies.  Every change is recorded with its inverse and can be taken back
//! with `undo_changes`.
//!
//! Sign-in is OAuth (oauth.rs).  The endpoint keeps no session of its own: every request
//! carries a bearer token and stands alone, so any replica can answer it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use base64::Engine;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::error::AppResult;
use crate::mcp_host::HostPool;
use crate::oauth::{self, Caller};
use crate::{persist, AppState};

const ASSISTANT_TOOLS: &str = include_str!("../web/domains/pcb/ai/tools.json");
const MCP_TOOLS: &str = include_str!("../web/domains/pcb/mcp/tools.json");
const GUIDE: &str = include_str!("../web/domains/pcb/mcp/guide.md");
/// The tools of the other domains, each from its own folder (web/domains/<id>/mcp/tools.json, the same
/// shape as the electronics list).  They all run in the headless editor, which has the same folders'
/// code (web/domains/pcb/mcp/host.ts takes each domain's tool table).
const DOMAIN_TOOLS: &[(&str, &str)] = &[
    ("mechanical", include_str!("../web/domains/mechanical/mcp/tools.json")),
    ("assembly", include_str!("../web/domains/assembly/mcp/tools.json")),
];
/// The domains whose tools are Mechanical CAD's (`cad_*`): shown only to a person who has it turned on.
const CAD_DOMAINS: &[&str] = &["mechanical", "assembly"];

const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL: &str = "2025-06-18";
/// What a tool may return as text before it is cut (the assistant's own limit).
const MAX_RESULT_CHARS: usize = 120_000;
/// An undo is not kept for a change whose inverse is larger than this (a deleted pour with its fill).
const MAX_UNDO_BYTES: usize = 6 * 1024 * 1024;

const INSTRUCTIONS: &str = "Junction: the person's online KiCad projects (schematics and boards), shared live with their collaborators. \
Start with list_projects, then get_design_overview for the project. Every design tool takes the project (id or exact name) and usually a document (a path from get_project, or \"board\"). \
Read the design with the tools instead of guessing: coordinates are millimetres with Y down, schematic items sit on a 1.27 mm grid, and pins connect only when a wire end or label lands exactly on the pin's connection point. \
render_view shows a sheet or the board as a picture; scope it (area, refs, nets, layers, view_of a person) to keep it small. \
The people in the project see you as a collaborator: when you talk about a place in the design, call highlight so it is outlined on their canvas with a short note, and when they say \"this\" or \"here\", call get_selection to see what they have selected and where they are looking. When the person wants to review a change first, or you offer something they did not ask for, pass propose: true to apply_changes: they see it drawn over the design and Accept or Reject it (list_proposals gives the outcome; propose_fixes offers fixes for rule violations the same way). apply_changes edits the design at once and everyone in the project sees it live, so change only what the person asked for, use dry_run when unsure, check the result with run_checks and render_view, and take a wrong change back with undo_changes. \
Before drawing or rearranging a schematic, laying out or routing a board, or reviewing a design, read get_design_guide once (topic \"quick\" when the job is to lay out or route a whole board: one harness call, board.design(), does it and holds the rules); its schematic drawing rules are the owner's and are not optional. Plan first, draw once: try a run_python script with dry_run: true until its result is clean, then run it once for real; never clear a sheet or board to start again, and never type coordinates for small parts.";
/// Added to the instructions for a person who has Mechanical CAD turned on (`users.cad_enabled`), who is also
/// the only one shown the `cad_*` tools.
const CAD_INSTRUCTIONS: &str = " \
A project can also hold mechanical designs, worked on with the cad_ tools (lengths are millimetres, angles degrees, Z is up; they run on the server, so nothing has to be open in a browser). \
A part studio (a .jpart document, listed by get_project) is a list of features (sketch, extrude, fillet, hole and about 170 more) that the modelling kernel builds in order into solid bodies; an assembly (.jasm) places those bodies as instances and ties them with mates. \
Read cad_reference topic \"guide\" once before modelling (it has a whole part in one call), and topic \"mates\" before the first mate. \
Look cheaply first: cad_describe says what is there in a few lines, cad_get_features gives the tree and one feature in full, cad_feature_types searches the feature types and gives one type's parameters with an example. \
Change a part studio with cad_edit_features (several edits in one call; dry_run to try, atomic to refuse a call that would break a feature; every result says what each feature reports) and an assembly with cad_edit_assembly (insert parts, standard hardware from cad_search_models, mates; every result has the solve report). \
Refer to a face or an edge by a pick instead of guessing its name ({ kind: \"face\", body, pick: \"top\" }); cad_find_geometry lists the candidates. \
Check your work: cad_measure, cad_check (interference, clearance, thin walls), and cad_render_view to see it (views puts several in one picture, highlight shows a face, section cuts it open). cad_export writes STEP, STL, 3MF or DXF. undo_changes takes back a cad_ change by its change_id.";

// ------------------------------------------------------------------ the catalog

struct Tool {
    def: Value,
    /// One of the Mechanical CAD tools: listed only to a person who has CAD turned on.
    cad: bool,
    write: bool,
    /// Runs in the headless editor (false: answered here).
    host: bool,
    /// Takes a `project`.
    project: bool,
}

/// How an assistant tool is offered here: its name there, whether it takes a document,
/// its title, and a description when the assistant's speaks of the editor it runs in.
const REUSED: &[(&str, bool, &str, Option<&str>)] = &[
    ("get_design_overview", false, "Design overview", Some(
        "Summary of a project and of one of its documents: the project's schematic sheets and board, the person's role, and for the document its title block, how many symbols or footprints, wires or tracks and nets it has, its libraries and sub-sheets. Describes the root schematic sheet unless document names another sheet or the board. Call this first when you do not yet know what the design is.")),
    ("list_components", true, "List components", Some(
        "List the components of a schematic sheet (symbols) or of the board (footprints): reference, value, footprint, library id, position, and whether a Datasheet link and part number fields are present. Power symbols are left out unless include_power is true.")),
    ("get_component", true, "Get component", None),
    ("list_nets", true, "List nets", None),
    ("run_checks", true, "Run ERC or DRC", None),
    ("get_board_info", false, "Board info", None),
    ("get_items", true, "Get items", None),
    ("find_datasheets", true, "Find datasheets", Some(
        "For the parts of a schematic sheet or the board, grouped by part: the references that use it, value, footprint, the Datasheet field and any manufacturer, part number or distributor fields. Fetch the link to read the datasheet, or search the web for the part number when there is no usable link.")),
    ("read_datasheet", false, "Read datasheet", Some(
        "Read a PDF datasheet, application note or hardware design guide by its https address. The server downloads and indexes the file once and returns only the pages that answer the query, with page numbers, so a question costs a few thousand tokens instead of the whole document. Ask one focused question per call in the datasheet's own words (\"crystal load capacitance\", \"absolute maximum ratings\", a pin name), or give pages to read by number (up to 6). find_datasheets lists the datasheet links of a design's parts.")),
    ("find_parts", false, "Find parts", None),
    ("get_library_part", false, "Get library part", None),
];

const APPLY_HEAD: &str = "Change a schematic sheet or the board. The edits are validated against the live document and applied together as one change, through the same collaboration pipeline as a person's own edits: everyone who has the project open sees them at once, marked as made by the person through this app. If any edit is invalid nothing is applied and each problem is reported with its reason, so correct it and call again. With dry_run nothing is applied and the result says what the edits would do. Returns what each edit did, for a schematic how pin connections changed (a tidy-up must leave them unchanged), the engines' reports for placement and routing, and a change_id that undo_changes takes to revert the whole call. Only make changes the person asked for. Before drawing on a schematic read get_design_guide (topic schematic): the site's owner has firm drawing rules (wires inside a block and labels only between blocks, horizontal labels, supplies up and ground down, decoupling capacitors in a row on shared rails). ";

fn project_prop() -> Value {
    json!({ "type": "string", "description": "Project id or exact name, as listed by list_projects." })
}

/// What the `document` argument is, as everybody is told it.
const DOCUMENT_DESC: &str = "Which document: its path as listed by get_project or get_design_overview (for example \"power.kicad_sch\"), or \"board\" for the board.";
/// Added for a person who has Mechanical CAD on, whose projects may hold several PCBs (the project shell comes
/// with CAD: web/shared/cad.ts).  A project of somebody else's that has several still works for anybody: each
/// call's answer says which PCB it worked on (web/domains/pcb/mcp/host.ts scopeToPcb).
const DOCUMENT_DESC_PCBS: &str = " In a project with several PCBs (each a folder, as get_project lists them) say which PCB: \"Motor driver/board\", \"Motor driver/schematic\" or the full path \"Motor driver/power.kicad_sch\"; a call that names none works on the PCB used last.";

fn document_prop() -> Value {
    json!({ "type": "string", "description": format!("{DOCUMENT_DESC}{DOCUMENT_DESC_PCBS}") })
}

/// A tool as tools/list shows it to a person with Mechanical CAD on or off: off, the `document` argument is
/// described as the PCB editor alone has it (one PCB per project).
fn def_for(t: &Tool, cad: bool) -> Value {
    let mut def = t.def.clone();
    if !cad {
        if let Some(doc) = def.pointer_mut("/inputSchema/properties/document") {
            doc["description"] = json!(DOCUMENT_DESC);
        }
    }
    def
}

fn annotations(title: &str, write: bool, destructive: bool) -> Value {
    json!({ "title": title, "readOnlyHint": !write, "destructiveHint": write && destructive, "idempotentHint": !write, "openWorldHint": false })
}

/// The annotations of a domain's tool: its tools.json may say `idempotent` (a write that is safe to repeat, a
/// read that leaves a file behind) and `open_world` (it asks services outside this server).
fn domain_annotations(title: &str, t: &Value) -> Value {
    let write = t["write"].as_bool().unwrap_or(false);
    let mut a = annotations(title, write, t["destructive"].as_bool().unwrap_or(false));
    if let Some(v) = t["idempotent"].as_bool() {
        a["idempotentHint"] = json!(v);
    }
    if let Some(v) = t["open_world"].as_bool() {
        a["openWorldHint"] = json!(v);
    }
    a
}

fn build_catalog() -> Vec<Tool> {
    let assistant: Vec<Value> = serde_json::from_str(ASSISTANT_TOOLS).expect("web/domains/pcb/ai/tools.json is valid JSON");
    let find = |name: &str| -> &Value {
        assistant.iter().find(|t| t["name"] == name).unwrap_or_else(|| panic!("web/domains/pcb/ai/tools.json has no tool {name}"))
    };
    let mut out = Vec::new();

    for (name, document, title, description) in REUSED {
        let src = find(name);
        let mut schema = src["input_schema"].clone();
        let takes_project = !matches!(*name, "find_parts" | "get_library_part" | "read_datasheet");
        {
            let props = schema["properties"].as_object_mut().expect("tool schema has properties");
            // The assistant reads "the open document" unless told otherwise; here every call names its own.
            props.remove("doc");
            let mut ordered = Map::new();
            if takes_project {
                ordered.insert("project".into(), project_prop());
            }
            if *document || *name == "get_design_overview" {
                ordered.insert("document".into(), document_prop());
            }
            ordered.extend(std::mem::take(props));
            *props = ordered;
        }
        let mut required: Vec<Value> = schema["required"].as_array().cloned().unwrap_or_default();
        if *document {
            required.insert(0, json!("document"));
        }
        if takes_project {
            required.insert(0, json!("project"));
        }
        if !required.is_empty() {
            schema["required"] = Value::Array(required);
        }
        let description = description
            .map(str::to_string)
            .unwrap_or_else(|| src["description"].as_str().unwrap_or("").replace("in the same proposal", "in the same apply_changes call"));
        out.push(Tool {
            def: json!({ "name": name, "title": title, "description": description, "inputSchema": schema, "annotations": annotations(title, false, false) }),
            write: false,
            host: true,
            project: takes_project,
            cad: false,
        });
    }

    // apply_changes is the assistant's propose_changes: the same edits, applied instead of parked on a card.
    {
        let src = find("propose_changes");
        let text = src["description"].as_str().unwrap_or("");
        let ops = text.find("Edits, by `op`:").map(|at| &text[at..]).expect("propose_changes describes its edits");
        let ops = ops
            .replace("run the board autorouter over the missing connections of these nets (every unrouted net when nets is omitted) and propose the tracks and vias it finds", "run the board autorouter over the missing connections of these nets (every unrouted net when nets is omitted) and add the tracks and vias it finds")
            .replace("put it in a proposal of its own", "put it in a call of its own")
            .replace("so wires in the same proposal end exactly on the pins", "so wires in the same call end exactly on the pins")
            .replace("written to the project file when accepted", "written to the project file");
        debug_assert!(!ops.contains("proposal") && !ops.contains("propose"), "apply_changes still speaks of proposals");
        let mut schema = src["input_schema"].clone();
        {
            let props = schema["properties"].as_object_mut().expect("propose_changes has properties");
            let mut ordered = Map::new();
            ordered.insert("project".into(), project_prop());
            ordered.insert("document".into(), document_prop());
            ordered.insert("title".into(), json!({ "type": "string", "description": "A few words naming the change. It is what the person sees in the list of changes." }));
            ordered.insert("rationale".into(), json!({ "type": "string", "description": "One or two sentences on why, for someone who has not read the conversation." }));
            ordered.insert("edits".into(), props["edits"].clone());
            ordered.insert("dry_run".into(), json!({ "type": "boolean", "description": "Validate and describe the edits without applying them." }));
            ordered.insert("propose".into(), json!({ "type": "boolean", "description": "Do not apply: show the change to the people in the document, drawn over the design, to Accept or Reject. Use it when the person asked to review changes first, for anything you are unsure of, and for fixes you offer unasked. list_proposals gives the outcome." }));
            ordered.insert("live".into(), json!({ "type": "boolean", "description": "Draw the change a few items at a time with your cursor on them, so people in the document can follow (default false: applied at once)." }));
            *props = ordered;
        }
        schema["required"] = json!(["project", "document", "title", "edits"]);
        out.push(Tool {
            def: json!({ "name": "apply_changes", "title": "Apply changes", "description": format!("{APPLY_HEAD}{ops}"), "inputSchema": schema, "annotations": annotations("Apply changes", true, true) }),
            write: true,
            host: true,
            project: true,
            cad: false,
        });
    }

    let extra: Vec<Value> = serde_json::from_str(MCP_TOOLS).expect("web/domains/pcb/mcp/tools.json is valid JSON");
    for t in extra {
        let name = t["name"].as_str().expect("tool name").to_string();
        let title = t["title"].as_str().unwrap_or(&name).to_string();
        let write = t["write"].as_bool().unwrap_or(false);
        let project = t["input_schema"]["properties"].get("project").is_some();
        let host = !matches!(name.as_str(), "list_projects" | "get_project" | "list_changes" | "get_design_guide" | "get_run" | "view_datasheet");
        out.push(Tool {
            def: json!({ "name": name, "title": title, "description": t["description"], "inputSchema": t["input_schema"],
                         "annotations": annotations(&title, write, name == "undo_changes" || name == "redo_changes") }),
            write,
            host,
            project,
            cad: false,
        });
    }

    for (domain, list) in DOMAIN_TOOLS {
        let tools: Vec<Value> = serde_json::from_str(list).unwrap_or_else(|e| panic!("web/domains/{domain}/mcp/tools.json is not valid JSON: {e}"));
        for t in tools {
            let name = t["name"].as_str().expect("tool name").to_string();
            let title = t["title"].as_str().unwrap_or(&name).to_string();
            let write = t["write"].as_bool().unwrap_or(false);
            let project = t["input_schema"]["properties"].get("project").is_some();
            out.push(Tool {
                def: json!({ "name": name, "title": title, "description": t["description"], "inputSchema": t["input_schema"],
                             "annotations": domain_annotations(&title, &t) }),
                write,
                host: true,
                project,
                cad: CAD_DOMAINS.contains(domain),
            });
        }
    }

    // The order a model reads them in: find the project, read, look, change, then the rest.
    let order = [
        "list_projects", "get_project", "get_design_overview", "get_design_guide", "list_components", "get_component", "list_nets",
        "get_items", "run_checks", "review_design", "check_layout", "get_board_info", "render_view", "highlight", "get_selection", "trace_net", "compare_versions", "get_bom", "simulate", "export_fab", "find_datasheets", "read_datasheet", "view_datasheet", "find_parts", "get_library_part", "run_python", "get_run", "apply_changes", "propose_fixes", "list_proposals",
        "undo_changes", "redo_changes", "list_changes", "read_document", "list_comments", "add_comment", "resolve_comment", "list_checkpoints",
        "create_checkpoint", "create_project", "get_geometry",
    ];
    out.sort_by_key(|t| order.iter().position(|n| t.def["name"] == *n).unwrap_or(order.len()));
    out
}

/// What tools/list shows: an app that was allowed to read only is not shown the tools that change things, and a
/// person who has Mechanical CAD turned off is not shown the `cad_*` tools.
fn listed(can_write: bool, cad: bool) -> impl Iterator<Item = &'static Tool> {
    catalog().iter().filter(move |t| (can_write || !t.write) && (cad || !t.cad))
}

/// Whether the caller has Mechanical CAD turned on (users.cad_enabled).  A failed read counts as off.
async fn cad_on(state: &AppState, caller: &Caller) -> bool {
    crate::persist::cad_enabled(&state.pool, caller.user.id).await.unwrap_or_else(|e| {
        tracing::error!("mcp: reading the CAD setting: {e}");
        false
    })
}

const CAD_OFF: &str = "Mechanical CAD is turned off for this account. The person can turn it on in Junction (the account menu on the projects page, or the Junction menu in the editor: Mechanical CAD); the cad_ tools are listed once it is on.";

fn catalog() -> &'static [Tool] {
    static CATALOG: OnceLock<Vec<Tool>> = OnceLock::new();
    CATALOG.get_or_init(build_catalog)
}

pub(crate) fn hosts() -> &'static HostPool {
    static POOL: OnceLock<HostPool> = OnceLock::new();
    POOL.get_or_init(HostPool::new)
}

// ------------------------------------------------------------------ prompts

const PROMPTS: &[(&str, &str, &str, &str)] = &[
    ("review_design", "Review a design", "Review a project's schematic and board and report the problems, ranked.",
     "Review the KiCad project {project} on Junction. Read get_design_guide (topic review) first, then the design itself: the overview, the components and nets of every sheet, the ERC and the DRC, a picture of each sheet and of the board, and the datasheets of the ICs. Report what would stop it from working first, then what is risky, then polish, naming the references and nets. Do not change anything unless I ask."),
    ("tidy_schematic", "Tidy a schematic", "Rearrange a schematic sheet so it reads cleanly, without changing any connection.",
     "Tidy the schematic of the KiCad project {project} on Junction so it reads like a careful engineer drew it. Read get_design_guide (topic schematic) first. Work one functional block per change, look at the sheet with render_view before and after, and make sure every change reports connectivity unchanged; undo any that does not."),
    ("design_board", "Design a board from a description", "Take a design from a description to a placed and routed board, in stages.",
     "Design this on Junction, in the project {project} (create it if it does not exist): {description}. Read get_design_guide first and work in its stages: requirements, parts with their datasheets, the schematic block by block, the board (update from schematic, outline, placement), rules and routing, then the checks and a short report of what to look at before ordering."),
];

/// The prompts of Mechanical CAD: listed to a person who has it turned on.
const CAD_PROMPTS: &[(&str, &str, &str, &str)] = &[
    ("design_part", "Design a mechanical part", "Model a part (a bracket, an enclosure, a knob) in a part studio from a description, and check it.",
     "Design this mechanical part on Junction, in the project {project} (create it if it does not exist): {description}. Read cad_reference topic \"guide\" first. Make a part studio with cad_create_part_studio, then build the part with cad_edit_features in a few calls: the base solid first, then cuts and holes, then fillets and chamfers last. Use variables for the dimensions that matter and refer to faces by a pick, not by a guessed name. After each call read the result: fix a failed feature before adding more. When it is built, give the part a name and a material (set_part), check it with cad_check (thickness too if it is to be printed or moulded), look at it with cad_render_view (views: iso, top, front, right in one picture), and tell me its size, mass and anything I should decide."),
    ("design_bracket", "Design a bracket", "An L-bracket or mounting plate with holes, from the loads and fasteners you describe.",
     "Design a bracket on Junction, in the project {project} (create it if it does not exist): {description}. Read cad_reference topic \"guide\" first. Sketch the profile on the front plane and extrude it to the width (or sketch the plate on top and add the upright), drill the mounting holes with the hole feature at sketch points (clearance holes for the screws named, counterbored when the heads must sit flush), then fillet the inside corner and break the outer edges. Keep the wall at least 3 mm unless told otherwise, and holes at least one and a half diameters from an edge. Give it a material, then report its size and mass with a four-view picture."),
    ("make_assembly", "Make an assembly from parts", "Put the parts of a project together with mates and standard fasteners, and check that nothing collides.",
     "Make an assembly on Junction in the project {project}: {description}. Read cad_reference topic \"mates\" first, and cad_describe each part studio so you know the parts. Create the assembly with cad_create_assembly, insert the base part fixed, then each other part with one mate per joint (fastened for what is bolted down, revolute for a hinge, slider for a slide), picking connectors by description (the hole of a given diameter, the top face). Add the screws, nuts and washers as standard parts (cad_search_models, then insert with standard). After each call read the solve report: fix a conflicting mate before adding more. Finish with cad_check (interference), cad_get_bom, a picture (and an exploded one), and tell me the freedoms that are left and whether they are the ones intended."),
];

fn prompt_json(p: &(&str, &str, &str, &str)) -> Value {
    let (name, title, description, text) = p;
    let mut args = vec![json!({ "name": "project", "description": "The project's name", "required": true })];
    if text.contains("{description}") {
        args.push(json!({ "name": "description", "description": "What to build", "required": true }));
    }
    json!({ "name": name, "title": title, "description": description, "arguments": args })
}

/// `cad`: the caller has Mechanical CAD on, and is offered its prompts too.
fn prompts_list(cad: bool) -> Value {
    json!({ "prompts": PROMPTS.iter().chain(CAD_PROMPTS.iter().filter(|_| cad)).map(prompt_json).collect::<Vec<_>>() })
}

fn prompt_get(params: &Value) -> Result<Value, (i64, String)> {
    let name = params["name"].as_str().unwrap_or("");
    let Some((_, _, description, text)) = PROMPTS.iter().chain(CAD_PROMPTS.iter()).find(|p| p.0 == name) else {
        return Err((-32602, format!("unknown prompt {name}")));
    };
    let arg = |k: &str| params["arguments"][k].as_str().unwrap_or("").trim().to_string();
    let project = arg("project");
    let text = text
        .replace("{project}", if project.is_empty() { "(ask me which project)" } else { &project })
        .replace("{description}", &arg("description"));
    Ok(json!({ "description": description, "messages": [{ "role": "user", "content": { "type": "text", "text": text } }] }))
}

// ------------------------------------------------------------------ resources

/// The pages of the Mechanical CAD reference (web/domains/mechanical/mcp/reference.ts): uri, topic, title, description.
const CAD_RESOURCES: &[(&str, &str, &str, &str)] = &[
    ("junction://cad/guide", "guide", "How to model in Junction", "The workflow of the cad_ tools, a whole part in one call, and the rules that save time. Read it before modelling."),
    ("junction://cad/sketch", "sketch", "Sketch shapes and constraints", "The shapes a sketch is drawn with, entity ids, constraints and dimensions."),
    ("junction://cad/references", "references", "Naming and picking geometry", "How faces, edges and vertices are named, and picking them by description."),
    ("junction://cad/variables", "variables", "Variables, parts and materials", "Variables and expressions, part names, materials and their densities."),
    ("junction://cad/mates", "mates", "Assemblies and mates", "Inserting parts, connectors, every mate type with its parameters, and a hinge in one call."),
    ("junction://cad/features", "features", "The feature catalogue", "Every feature type of a part studio, one line each, by family."),
];

/// What resources/list shows: the electronics design guide for everybody, the CAD pages with Mechanical CAD on.
fn resources(cad: bool) -> Vec<Value> {
    let mut out = vec![json!({ "uri": "junction://guide/electronics", "name": "electronics-guide", "title": "Designing electronics in Junction",
        "description": "How to draw a schematic, lay out and route a board, and review a design (what get_design_guide returns, whole).", "mimeType": "text/markdown" })];
    if cad {
        out.extend(CAD_RESOURCES.iter().map(|(uri, topic, title, description)| json!({ "uri": uri, "name": format!("cad-{topic}"), "title": title, "description": description, "mimeType": "text/markdown" })));
    }
    out
}

fn export_mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "step" | "stp" => "model/step",
        "stl" => "model/stl",
        "3mf" => "model/3mf",
        "obj" => "model/obj",
        "glb" => "model/gltf-binary",
        "dxf" => "image/vnd.dxf",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}

/// The largest export handed over inside a resources/read answer; a larger one is fetched by its link.
const MAX_RESOURCE_BYTES: usize = 12 * 1024 * 1024;

async fn resource_read(state: &AppState, caller: &Caller, uri: &str) -> Result<Value, (i64, String)> {
    let text = |body: String| Ok(json!({ "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": body }] }));
    if uri == "junction://guide/electronics" {
        return text(GUIDE.to_string());
    }
    if let Some((_, topic, _, _)) = CAD_RESOURCES.iter().find(|r| r.0 == uri) {
        if !cad_on(state, caller).await {
            return Err((-32002, CAD_OFF.to_string()));
        }
        // the pages are the tool host's own (one text for the tool and the resource)
        let request = json!({
            "base": own_address(), "token": internal_token(state, caller), "agent": if caller.client.is_empty() { "AI assistant" } else { caller.client.as_str() },
            "canWrite": false, "user": { "id": caller.user.id, "login": caller.user.login, "name": caller.user.login },
            "tool": "cad_reference", "project": Value::Null, "args": { "topic": topic },
        });
        let reply = hosts().call(caller.user.id, request, Duration::from_secs(60)).await.map_err(|e| (-32603, e.to_string()))?;
        return match reply["result"].as_str() {
            Some(body) if reply["ok"] == true => text(body.to_string()),
            _ => Err((-32603, reply["error"].as_str().unwrap_or("The page could not be read.").to_string())),
        };
    }
    if let Some(id) = uri.strip_prefix("junction://exports/").and_then(|s| Uuid::parse_str(s).ok()) {
        let gone = || (-32002, "There is no such export: exports are kept for two weeks, and only the newest few of a project. Run the export again.".to_string());
        let row = sqlx::query("SELECT project_id, name, bytes FROM project_exports WHERE id = $1").bind(id).fetch_optional(&state.pool).await
            .map_err(|e| { tracing::error!("mcp: reading an export: {e}"); (-32603, "The export could not be read.".to_string()) })?
            .ok_or_else(gone)?;
        // a member of the export's project, as the download link asks
        let role = persist::effective_role(&state.pool, caller.user.id, row.get("project_id")).await.map_err(|_| gone())?;
        if role.is_none() {
            return Err(gone());
        }
        let name: String = row.get("name");
        let bytes: Vec<u8> = row.get("bytes");
        if bytes.len() > MAX_RESOURCE_BYTES {
            return Err((-32603, format!("{name} is {} MB, too large to hand over here. Give the person the download link from the tool's result.", bytes.len() / 1024 / 1024)));
        }
        let mime = export_mime(&name);
        let textual = matches!(mime, "model/step" | "image/vnd.dxf" | "image/svg+xml" | "model/obj" | "text/csv");
        return Ok(match (textual, String::from_utf8(bytes)) {
            (true, Ok(body)) => json!({ "contents": [{ "uri": uri, "name": name, "mimeType": mime, "text": body }] }),
            (_, Ok(body)) => json!({ "contents": [{ "uri": uri, "name": name, "mimeType": mime, "blob": base64::engine::general_purpose::STANDARD.encode(body.as_bytes()) }] }),
            (_, Err(e)) => json!({ "contents": [{ "uri": uri, "name": name, "mimeType": mime, "blob": base64::engine::general_purpose::STANDARD.encode(e.as_bytes()) }] }),
        });
    }
    Err((-32002, format!("There is no resource {uri}. resources/list shows them.")))
}

// ------------------------------------------------------------------ HTTP

fn unauthorized(state: &AppState, headers: &HeaderMap) -> Response {
    let challenge = format!("Bearer resource_metadata=\"{}\"", oauth::resource_metadata_url(state, headers));
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, HeaderValue::from_str(&challenge).unwrap_or(HeaderValue::from_static("Bearer")))],
        Json(json!({ "error": "unauthorized", "message": "Sign in to use this MCP server: your client will send you to the sign-in page." })),
    )
        .into_response()
}

/// `GET /mcp`: a browser gets the page that explains how to connect; an MCP client asking
/// for a server-to-client stream is told there is none (the endpoint only answers requests).
pub async fn get(headers: HeaderMap) -> Response {
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("");
    if accept.contains("text/html") {
        return Redirect::to("/connect").into_response();
    }
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

/// `DELETE /mcp`: there is no session to end.
pub async fn delete() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// `POST /mcp`: one JSON-RPC message (or a batch of them, for clients of the older revision).
pub async fn post(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let caller = match oauth::caller(&state, &headers).await {
        Ok(Some(c)) => c,
        Ok(None) => return unauthorized(&state, &headers),
        Err(e) => {
            tracing::error!("mcp: authentication failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(rpc_error(Value::Null, -32700, "the body is not JSON"))).into_response();
    };
    let caller = std::sync::Arc::new(caller);
    let site = oauth::origin_of(&state, &headers);

    if let Value::Array(batch) = message {
        let mut replies = Vec::new();
        for m in batch {
            if let Some(reply) = handle(&state, &caller, &site, m).await {
                replies.push(reply);
            }
        }
        return if replies.is_empty() { StatusCode::ACCEPTED.into_response() } else { Json(Value::Array(replies)).into_response() };
    }

    // A tool call can compute for minutes (the autorouter).  When the client takes a stream,
    // answer with one and keep it warm, so nothing in between gives up on a silent connection.
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("");
    let slow = message["method"] == "tools/call" && message.get("id").is_some() && accept.contains("text/event-stream");
    if !slow {
        return match handle(&state, &caller, &site, message).await {
            Some(reply) => Json(reply).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        };
    }

    let progress = message["params"]["_meta"].get("progressToken").cloned();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    tokio::spawn(async move {
        let work = handle(&state, &caller, &site, message);
        tokio::pin!(work);
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        tick.tick().await;
        let mut n = 0u64;
        let reply = loop {
            tokio::select! {
                reply = &mut work => break reply,
                _ = tick.tick() => {
                    n += 1;
                    let frame = match &progress {
                        Some(token) => format!("event: message\ndata: {}\n\n", json!({
                            "jsonrpc": "2.0", "method": "notifications/progress",
                            "params": { "progressToken": token, "progress": n, "message": format!("Working ({} s)", n * 10) } })),
                        None => ": working\n\n".to_string(),
                    };
                    if tx.send(Ok(Bytes::from(frame))).await.is_err() {
                        return;   // the client went away; the call itself is left to finish
                    }
                }
            }
        };
        if let Some(reply) = reply {
            let _ = tx.send(Ok(Bytes::from(format!("event: message\ndata: {reply}\n\n")))).await;
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache, no-transform"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

/// Answer one JSON-RPC message.  `None` for a notification or a response, which get no reply.
async fn handle(state: &AppState, caller: &Arc<Caller>, site: &str, message: Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?.to_string();
    let id = message.get("id").cloned()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result: Result<Value, (i64, String)> = match method.as_str() {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { DEFAULT_PROTOCOL };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false }, "prompts": { "listChanged": false }, "resources": { "subscribe": false, "listChanged": false } },
                "serverInfo": { "name": "junction", "title": "Junction", "version": env!("CARGO_PKG_VERSION"),
                    "websiteUrl": site,
                    "icons": [
                        { "src": format!("{site}/brand/{v}/icon-192.png", v = crate::pages::ICON_V), "mimeType": "image/png", "sizes": ["192x192"] },
                        { "src": format!("{site}/brand/{v}/icon-512.png", v = crate::pages::ICON_V), "mimeType": "image/png", "sizes": ["512x512"] },
                        { "src": format!("{site}/brand/{v}/icon.svg", v = crate::pages::ICON_V), "mimeType": "image/svg+xml", "sizes": ["any"] },
                    ] },
                "instructions": if cad_on(state, caller).await { format!("{INSTRUCTIONS}{CAD_INSTRUCTIONS}") } else { INSTRUCTIONS.to_string() },
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => {
            let cad = cad_on(state, caller).await;
            Ok(json!({ "tools": listed(caller.can_write, cad).map(|t| def_for(t, cad)).collect::<Vec<_>>() }))
        }
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = match params.get("arguments") {
                Some(Value::Object(o)) => Value::Object(o.clone()),
                None | Some(Value::Null) => json!({}),
                Some(_) => return Some(rpc_error(id, -32602, "arguments must be an object")),
            };
            match catalog().iter().find(|t| t.def["name"] == name.as_str()) {
                None => Err((-32602, format!("unknown tool {name}"))),
                Some(tool) if tool.cad && !cad_on(state, caller).await => Ok(json!({ "content": [{ "type": "text", "text": CAD_OFF }], "isError": true })),
                Some(tool) => Ok(match run_tool(state, caller, site, tool, &name, args).await {
                    Ok(content) => json!({ "content": content, "isError": false }),
                    Err(message) => json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
                }),
            }
        }
        "prompts/list" => Ok(prompts_list(cad_on(state, caller).await)),
        "prompts/get" => {
            let name = params["name"].as_str().unwrap_or("");
            if CAD_PROMPTS.iter().any(|p| p.0 == name) && !cad_on(state, caller).await {
                Err((-32602, CAD_OFF.to_string()))
            } else {
                prompt_get(&params)
            }
        }
        "resources/list" => Ok(json!({ "resources": resources(cad_on(state, caller).await) })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [{
            "uriTemplate": "junction://exports/{id}", "name": "export", "title": "An exported file",
            "description": "A file a tool made for a project (cad_export, export_fab), by the id in the tool's result. Kept for two weeks.",
        }] })),
        "resources/read" => resource_read(state, caller, params["uri"].as_str().unwrap_or("")).await,
        "logging/setLevel" => Ok(json!({})),
        _ => Err((-32601, format!("method {method} is not supported"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

// ------------------------------------------------------------------ long calls

/// A tool call that outlived the wait its caller was given: it goes on here and get_run collects it.
struct Run {
    user: i64,
    started: Instant,
    task: tokio::task::JoinHandle<Result<Value, String>>,
}

/// How long a call may take before it is answered with a run to collect.  Claude's connectors give
/// up on a tool call after a minute, and a script that lays out and routes a board takes several.
const RUN_WAIT: Duration = Duration::from_secs(45);
/// A run nobody collected is forgotten after this long (its edits stay; only the report is lost).
const RUN_KEPT: Duration = Duration::from_secs(3600);

fn runs() -> &'static Mutex<HashMap<String, Run>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Run>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The tools that can take minutes run as a task of their own, so that a caller who stops waiting
/// (or is cut off) does not stop the work, and the change records are stored whatever happens.
async fn run_tool(state: &AppState, caller: &Arc<Caller>, site: &str, tool: &'static Tool, name: &str, args: Value) -> Result<Value, String> {
    if name == "get_run" {
        let id = args["run_id"].as_str().unwrap_or("").to_string();
        let run = runs().lock().unwrap().remove(&id).filter(|r| r.user == caller.user.id);
        let Some(run) = run else {
            return Err("There is no run with that id still waiting to be collected: its result was already returned, or it is more than an hour old. list_changes shows what it changed.".into());
        };
        let wait = Duration::from_secs(args["wait_s"].as_u64().unwrap_or(45).clamp(1, 50));
        return settle(Some(id), run, wait).await;
    }
    if !matches!(name, "run_python" | "apply_changes") {
        return call_tool(state, caller, site, tool, name, args).await;
    }
    let (state, caller, site, name) = (state.clone(), caller.clone(), site.to_string(), name.to_string());
    let user = caller.user.id;
    let task = tokio::spawn(async move { call_tool(&state, &caller, &site, tool, &name, args).await });
    // KC_MCP_RUN_WAIT (seconds) shortens the wait, for tests of the hand-over
    let wait = std::env::var("KC_MCP_RUN_WAIT").ok().and_then(|v| v.parse().ok()).map(Duration::from_secs).unwrap_or(RUN_WAIT);
    settle(None, Run { user, started: Instant::now(), task }, wait).await
}

/// The run's result when it comes within `wait`; otherwise the run is kept and the answer says how to collect it.
async fn settle(id: Option<String>, mut run: Run, wait: Duration) -> Result<Value, String> {
    match tokio::time::timeout(wait, &mut run.task).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            tracing::error!("mcp: a run stopped: {e}");
            Err("The run stopped unexpectedly. list_changes shows what it changed before that.".into())
        }
        Err(_) => {
            let id = id.unwrap_or_else(|| Uuid::new_v4().simple().to_string()[..12].to_string());
            let seconds = run.started.elapsed().as_secs();
            let mut all = runs().lock().unwrap();
            all.retain(|_, r| r.started.elapsed() < RUN_KEPT);
            all.insert(id.clone(), run);
            Ok(json!([text_content(&json!({
                "running": true, "run_id": id, "seconds": seconds,
                "note": "Still working: the design is drawn in the document as each part of the script finishes planning. Call get_run with this run_id to wait for the result; do not start the same call again.",
            }))]))
        }
    }
}

// ------------------------------------------------------------------ projects

struct ProjectCtx {
    id: Uuid,
    name: String,
    role: String,
    docs: Vec<persist::Document>,
}

impl ProjectCtx {
    fn to_json(&self) -> Value {
        json!({ "projectId": self.id, "name": self.name, "role": self.role,
                "docs": self.docs.iter().map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type })).collect::<Vec<_>>() })
    }
}

fn internal(e: impl std::fmt::Display) -> String {
    tracing::error!("mcp: {e}");
    "The server had a problem answering. Try again.".to_string()
}

/// The project a tool call names, if the person may see it.
async fn resolve_project(state: &AppState, caller: &Caller, key: &Value) -> Result<ProjectCtx, String> {
    let key = key.as_str().map(str::trim).filter(|k| !k.is_empty()).ok_or("project is required: its id or exact name, from list_projects.")?;
    let mine = persist::list_projects_for_user(&state.pool, caller.user.id).await.map_err(internal)?;
    let found = if let Ok(id) = key.parse::<Uuid>() {
        match mine.iter().find(|p| p.id == id) {
            Some(p) => Some((p.id, p.name.clone(), p.role.clone())),
            // Not in the person's list, but perhaps public: readable, never writable.
            None => match persist::effective_role(&state.pool, caller.user.id, id).await.map_err(internal)? {
                Some(role) => persist::get_project(&state.pool, id).await.map_err(internal)?.map(|p| (p.id, p.name, role)),
                None => None,
            },
        }
    } else {
        let lower = key.to_lowercase();
        let exact: Vec<_> = mine.iter().filter(|p| p.name.to_lowercase() == lower).collect();
        match exact.len() {
            1 => Some((exact[0].id, exact[0].name.clone(), exact[0].role.clone())),
            0 => None,
            _ => {
                return Err(format!(
                    "{} projects are named \"{key}\". Use the id of the one you mean: {}.",
                    exact.len(),
                    exact.iter().map(|p| format!("{} (owner {})", p.id, p.owner_login)).collect::<Vec<_>>().join(", ")
                ))
            }
        }
    };
    let Some((id, name, role)) = found else {
        let names: Vec<_> = mine.iter().take(30).map(|p| p.name.as_str()).collect();
        return Err(format!(
            "There is no project \"{key}\" this person can open. Their projects: {}.",
            if names.is_empty() { "(none yet; create_project starts one)".to_string() } else { names.join(", ") }
        ));
    };
    let docs = persist::project_documents(&state.pool, id).await.map_err(internal)?;
    Ok(ProjectCtx { id, name, role, docs })
}

async fn list_projects(state: &AppState, caller: &Caller, site: &str, args: &Value) -> Result<Value, String> {
    let q = args["query"].as_str().unwrap_or("").to_lowercase();
    let mut rows = persist::list_projects_for_user(&state.pool, caller.user.id).await.map_err(internal)?;
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let rows: Vec<_> = rows
        .iter()
        .filter(|p| q.is_empty() || p.name.to_lowercase().contains(&q) || p.description.to_lowercase().contains(&q))
        .collect();
    let cap = 100;
    Ok(json!({
        "account": caller.user.login,
        "count": rows.len(),
        "projects": rows.iter().take(cap).map(|p| json!({
            "id": p.id, "name": p.name, "role": p.role, "owner": p.owner_login,
            "description": if p.description.is_empty() { None } else { Some(&p.description) },
            "documents": p.doc_count, "members": p.member_count, "starred": if p.starred { Some(true) } else { None },
            "updated": p.updated_at.to_rfc3339(), "url": format!("{site}/p/{}/edit", p.id),
        })).collect::<Vec<_>>(),
        "truncated": if rows.len() > cap { Some(format!("showing {cap} of {}; narrow with query", rows.len())) } else { None },
    }))
}

/// `cad`: the caller has Mechanical CAD on (the note then speaks of the cad_ tools too).
async fn get_project(state: &AppState, site: &str, p: &ProjectCtx, cad: bool) -> Result<Value, String> {
    let members = persist::list_members(&state.pool, p.id).await.map_err(internal)?;
    let kind = |t: &str| crate::dockind::of(t).name;
    Ok(json!({
        "id": p.id, "name": p.name, "your_role": p.role, "url": format!("{site}/p/{}/edit", p.id),
        "documents": p.docs.iter().map(|d| json!({ "path": d.path, "type": kind(&d.doc_type) })).collect::<Vec<_>>(),
        "members": members.iter().map(|m| json!({ "login": m.login, "role": m.role })).collect::<Vec<_>>(),
        "scripts": script_list(state, p).await,
        "note": if cad {
            "Schematic sheets and the board are what the document parameter of the electronics tools takes; a part studio or an assembly is what the cad_ tools take."
        } else {
            "Schematic sheets and the board are what the document parameter of the other tools takes."
        },
    }))
}

async fn list_changes(state: &AppState, caller: &Caller, p: &ProjectCtx, args: &Value) -> Result<Value, String> {
    let only = match args["document"].as_str().filter(|d| !d.trim().is_empty()) {
        Some(name) => Some(find_doc(p, name)?.id),
        None => None,
    };
    let rows = sqlx::query(
        "SELECT id, doc_id, title, edits, client, undo IS NOT NULL AS can_undo, undone_at, created_at
         FROM mcp_changes WHERE project_id = $1 AND user_id = $2 AND ($3::uuid IS NULL OR doc_id = $3)
         ORDER BY id DESC LIMIT 50",
    )
    .bind(p.id)
    .bind(caller.user.id)
    .bind(only)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    let changes: Vec<Value> = rows
        .iter()
        .map(|r| {
            let doc_id: Uuid = r.get("doc_id");
            let edits: Value = r.get("edits");
            let edits = edits.as_array().cloned().unwrap_or_default();
            json!({
                "change_id": r.get::<i64, _>("id"),
                "title": r.get::<String, _>("title"),
                "document": p.docs.iter().find(|d| d.id == doc_id).map(|d| d.path.clone()),
                "edits": edits.iter().take(12).collect::<Vec<_>>(),
                "more_edits": if edits.len() > 12 { Some(edits.len() - 12) } else { None },
                "made_with": Some(r.get::<String, _>("client")).filter(|c| !c.is_empty()).unwrap_or_else(|| "AI assistant".into()),
                "at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
                "undone": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").map(|t| t.to_rfc3339()),
                "can_undo": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").is_none() && r.get::<bool, _>("can_undo"),
                "can_redo": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").is_some() && r.get::<bool, _>("can_undo"),
            })
        })
        .collect();
    Ok(json!({ "project": p.name, "count": changes.len(), "changes": changes }))
}

fn find_doc<'a>(p: &'a ProjectCtx, name: &str) -> Result<&'a persist::Document, String> {
    let q = name.trim().to_lowercase();
    let base = |path: &str| path.rsplit('/').next().unwrap_or(path).to_lowercase();
    p.docs
        .iter()
        .find(|d| d.path.to_lowercase() == q)
        .or_else(|| p.docs.iter().find(|d| base(&d.path) == q))
        .or_else(|| if matches!(q.as_str(), "board" | "pcb") { p.docs.iter().find(|d| d.doc_type == "kicad_pcb") } else { None })
        // "<PCB folder>/board": the board of that PCB, in a project that has several
        .or_else(|| {
            let folder = q.strip_suffix("/board").or_else(|| q.strip_suffix("/pcb"))?;
            p.docs.iter().find(|d| d.doc_type == "kicad_pcb" && d.path.to_lowercase().starts_with(&format!("{folder}/")))
        })
        .ok_or_else(|| format!("There is no document \"{name}\" in {}.", p.name))
}

// ------------------------------------------------------------------ calling a tool

fn guide(topic: &str) -> Result<String, String> {
    let heading = match topic {
        "" | "all" => return Ok(GUIDE.to_string()),
        // The short way to a finished board: one harness call that holds the rules, so this topic comes alone.
        "quick" => {
            let start = GUIDE.find("## A board in one call").unwrap_or(0);
            let rest = &GUIDE[start..];
            let end = rest[2..].find("\n## ").map(|i| i + 2).unwrap_or(rest.len());
            return Ok(format!("{}\n", rest[..end].trim_end()));
        }
        "schematic" => "## Drawing schematics",
        "board" => "## Designing a board from a prompt",
        "routing" => "## Routing a board",
        "layout" => "## Laying out a board by the physics",
        "review" => "## Reviewing a design",
        "python" => "## Scripting with Python",
        other => return Err(format!("There is no topic \"{other}\". Topics: all, quick, python, schematic, board, routing, layout, review.")),
    };
    // Every topic comes with the opening section: how changes work here applies to all of them.
    let section = |h: &str| -> &str {
        let start = GUIDE.find(h).unwrap_or(0);
        let rest = &GUIDE[start..];
        let end = rest[2..].find("\n## ").map(|i| i + 2).unwrap_or(rest.len());
        rest[..end].trim_end()
    };
    // A board is laid out by the physics: the board and routing topics bring that section with them.
    if topic == "board" || topic == "routing" {
        return Ok(format!("{}\n\n{}\n\n{}\n", section("## Working on a design"), section(heading), section("## Laying out a board by the physics")));
    }
    Ok(format!("{}\n\n{}\n", section("## Working on a design"), section(heading)))
}

fn text_content(result: &Value) -> Value {
    let mut text = match result {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if text.len() > MAX_RESULT_CHARS {
        let mut cut = MAX_RESULT_CHARS;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("… (cut: too long; ask for less with a filter)");
    }
    json!({ "type": "text", "text": text })
}

/// A token for the headless editor to act as the person against this server: short lived, it
/// never leaves the machine.
fn internal_token(state: &AppState, caller: &Caller) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = crate::auth::Claims { sub: caller.user.id, login: caller.user.login.clone(), iat: now, exp: now + 2 * 3600 };
    jsonwebtoken::encode(&jsonwebtoken::Header::default(), &claims, &jsonwebtoken::EncodingKey::from_secret(state.cfg.jwt_secret.as_bytes()))
        .expect("jwt encode")
}

fn own_address() -> String {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    format!("http://127.0.0.1:{port}")
}

/// Run a tool and return its MCP content, or the message of a failure the model can act on.
async fn call_tool(state: &AppState, caller: &Caller, site: &str, tool: &Tool, name: &str, mut args: Value) -> Result<Value, String> {
    if tool.write && !caller.can_write {
        return Err("This connection was allowed to read only. To let it make changes, disconnect it under Connected apps and connect again with \"Let it make changes\" ticked.".into());
    }
    let project = if tool.project { Some(resolve_project(state, caller, &args["project"]).await?) } else { None };

    // The person's role on the project decides, whatever the connection was allowed: a
    // commenter's assistant may comment, a viewer's may only read.  The endpoints the tools
    // go through refuse as well (http.rs, ws.rs); this is the answer a model can act on.
    if let (true, Some(p)) = (tool.write, &project) {
        let commenting = matches!(name, "add_comment" | "resolve_comment");
        let allowed = match p.role.as_str() {
            "editor" => true,
            "commenter" => commenting,
            _ => false,
        };
        if !allowed {
            return Err(match (p.role.as_str(), commenting) {
                ("commenter", _) => format!(
                    "This person can comment on \"{}\" but not change it. add_comment and resolve_comment work; to make changes they need the owner to give them the editor role.",
                    p.name
                ),
                (_, true) => format!(
                    "This person can only view \"{}\", not comment on it. They need the owner to give them the commenter or editor role.",
                    p.name
                ),
                _ => format!(
                    "This person can only view \"{}\". To change it they need the owner to give them the editor role.",
                    p.name
                ),
            });
        }
    }

    match name {
        "list_projects" => return Ok(json!([text_content(&list_projects(state, caller, site, &args).await?)])),
        "get_project" => {
            let cad = cad_on(state, caller).await;
            return Ok(json!([text_content(&get_project(state, site, project.as_ref().expect("project"), cad).await?)]));
        }
        "list_changes" => return Ok(json!([text_content(&list_changes(state, caller, project.as_ref().expect("project"), &args).await?)])),
        "get_design_guide" => return Ok(json!([{ "type": "text", "text": guide(args["topic"].as_str().unwrap_or(""))? }])),
        "view_datasheet" => {
            let url = args["url"].as_str().unwrap_or("").trim().to_string();
            if url.is_empty() || url.len() > 2000 { return Err("Give the https address of the PDF as url.".into()); }
            let pages: Option<Vec<usize>> = args["pages"].as_array().map(|l| l.iter().filter_map(Value::as_u64).map(|n| n as usize).collect());
            let px = args["width_px"].as_u64().unwrap_or(1300).clamp(600, 2000) as u32;
            let (pics, total, note) = crate::datasheet::page_images(state, &url, pages, args["query"].as_str(), px).await?;
            let mut content: Vec<Value> = pics.iter().map(|(_, png)| json!({ "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(png), "mimeType": "image/png" })).collect();
            content.push(text_content(&json!({ "url": url, "pages_shown": pics.iter().map(|(n, _)| *n).collect::<Vec<_>>(), "page_count": total, "note": note })));
            return Ok(Value::Array(content));
        }
        _ => {}
    }
    debug_assert!(tool.host);

    // undo_changes and redo_changes: the record of what to take back (or, once undone, what to put
    // back) is kept here; the editor does it, and hands over the record for the opposite direction.
    let mut undoing: Option<(i64, bool)> = None;
    if name == "undo_changes" || name == "redo_changes" {
        let redo = name == "redo_changes";
        let p = project.as_ref().expect("project");
        let row = sqlx::query(
            "SELECT id, doc_id, title, undo, undone_at FROM mcp_changes
             WHERE project_id = $1 AND user_id = $2 AND ($3::bigint IS NULL OR id = $3)
               AND ($3::bigint IS NOT NULL OR (undone_at IS NOT NULL) = $4)
             ORDER BY CASE WHEN $4 THEN undone_at END DESC NULLS LAST, id DESC LIMIT 1",
        )
        .bind(p.id)
        .bind(caller.user.id)
        .bind(args["change_id"].as_i64())
        .bind(redo)
        .fetch_optional(&state.pool)
        .await
        .map_err(internal)?;
        let Some(row) = row else {
            return Err(match args["change_id"].as_i64() {
                Some(id) => format!("There is no change {id} of yours in {}. list_changes shows them.", p.name),
                None if redo => format!("There is no undone change of yours in {} to redo.", p.name),
                None => format!("There is no change of yours in {} left to undo.", p.name),
            });
        };
        let id: i64 = row.get("id");
        let title: String = row.get("title");
        let undone = row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("undone_at").is_some();
        if undone != redo {
            return Err(if redo { format!("\"{title}\" (change {id}) has not been undone, so there is nothing to redo.") }
                       else { format!("\"{title}\" (change {id}) has already been undone. redo_changes puts it back.") });
        }
        let Some(undo) = row.get::<Option<Value>, _>("undo") else {
            return Err(format!("\"{title}\" (change {id}) is too large or too old to {} as a whole. Make a new change instead.", if redo { "redo" } else { "undo" }));
        };
        args["__record"] = json!({ "docId": row.get::<Uuid, _>("doc_id"), "title": title, "undo": undo });
        undoing = Some((id, redo));
    }
    if name == "create_project" {
        // Every other tool finds a project by its name, so a second one of the same name is a trap.
        let wanted = args["name"].as_str().unwrap_or("").trim().to_string();
        let taken: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM projects WHERE owner_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2) LIMIT 1")
            .bind(caller.user.id).bind(&wanted).fetch_optional(&state.pool).await.map_err(|e| { tracing::error!("mcp create_project: {e}"); "The server could not check the project name.".to_string() })?;
        if let Some(id) = taken {
            return Err(format!("This person already has a project named \"{wanted}\" (id {id}). Work on that one, or choose another name."));
        }
        args["__site"] = json!(site);
    }
    if name == "export_fab" || name == "cad_export" {
        args["__site"] = json!(site);
    }

    // run_python: a script kept with the project is run by its name, changed by a few replacements, or saved from
    // `code`, so the whole text crosses the wire once.
    let mut script_note: Option<Value> = None;
    if name == "run_python" {
        let p = project.as_ref().expect("project");
        match stored_script(state, caller, p, &mut args).await? {
            ScriptStep::Run(note) => script_note = note,
            ScriptStep::Done(answer) => return Ok(json!([text_content(&answer)])),
        }
    }

    let width_px = args["width_px"].as_u64().unwrap_or(1500).clamp(400, 2000) as u32;
    let request = json!({
        "base": own_address(),
        "token": internal_token(state, caller),
        "agent": if caller.client.is_empty() { "AI assistant" } else { caller.client.as_str() },
        "canWrite": caller.can_write,
        "user": { "id": caller.user.id, "login": caller.user.login, "name": caller.user.name.clone().unwrap_or_else(|| caller.user.login.clone()) },
        "tool": name,
        "project": project.as_ref().map(ProjectCtx::to_json),
        "args": args,
    });
    // The autorouter may be given up to five minutes by the call itself.
    let limit = Duration::from_secs(if name == "apply_changes" { 420 } else if name == "run_python" { 480 } else { 150 });
    let reply = hosts().call(caller.user.id, request, limit).await.map_err(|e| e.to_string())?;
    if reply["ok"] != true {
        return Err(reply["error"].as_str().unwrap_or("The tool failed.").to_string());
    }
    let mut result = reply["result"].clone();
    if let (Some(note), Some(obj)) = (script_note, result.as_object_mut()) {
        obj.insert("script".into(), note);
    }

    if let (Some(record), Some(p)) = (reply.get("record"), project.as_ref()) {
        match store_change(state, caller, p, record).await {
            Ok(id) => {
                result["change_id"] = json!(id);
                result["undo"] = json!(format!("undo_changes with change_id {id} takes this back."));
            }
            Err(e) => {
                tracing::error!("mcp: change record not stored: {e}");
                result["undo"] = json!("The change was applied, but no undo record could be stored for it.");
            }
        }
    }
    // run_python: one record per document the script changed
    if let (Some(records), Some(p)) = (reply.get("records").and_then(Value::as_array), project.as_ref()) {
        let mut ids = Vec::new();
        for record in records {
            match store_change(state, caller, p, record).await {
                Ok(id) => ids.push(id),
                Err(e) => tracing::error!("mcp: change record not stored: {e}"),
            }
        }
        if ids.len() == records.len() && !ids.is_empty() {
            result["change_ids"] = json!(ids);
            result["undo"] = json!("undo_changes takes the script's edits back, one document per call, newest first.");
        } else if !records.is_empty() {
            result["undo"] = json!("The edits were applied, but no undo record could be stored for all of them.");
        }
    }
    if let Some((id, redo)) = undoing {
        // The record now runs the other way: what this call did, to be taken back by the opposite tool.
        let back = reply.get("swap").filter(|u| u.to_string().len() <= MAX_UNDO_BYTES);
        if let Err(e) = sqlx::query("UPDATE mcp_changes SET undone_at = CASE WHEN $2 THEN NULL ELSE now() END, undo = $3 WHERE id = $1")
            .bind(id).bind(redo).bind(back).execute(&state.pool).await {
            tracing::error!("mcp: undo not recorded: {e}");
        }
        result["change_id"] = json!(id);
    }

    if let Some(svgs) = reply["svgs"].as_array() {
        let mut content = Vec::new();
        for svg in svgs.iter().filter_map(Value::as_str).take(4) {
            let svg = svg.to_string();
            let png = tokio::task::spawn_blocking(move || rasterize(&svg, width_px)).await.map_err(internal)??;
            content.push(json!({ "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&png.0), "mimeType": "image/png" }));
        }
        content.push(text_content(&result));
        return Ok(Value::Array(content));
    }
    // a picture the tool drew itself (a shaded view of a part)
    if let Some(png) = reply["png"].as_str() {
        return Ok(json!([{ "type": "image", "data": png, "mimeType": "image/png" }, text_content(&result)]));
    }
    // files the tool made, as links to resources the client can read (an export)
    if let Some(links) = reply["links"].as_array().filter(|l| !l.is_empty()) {
        let mut content = vec![text_content(&result)];
        for l in links.iter().take(8) {
            if let (Some(uri), Some(name)) = (l["uri"].as_str(), l["name"].as_str()) {
                let mut link = json!({ "type": "resource_link", "uri": uri, "name": name });
                if let Some(m) = l["mimeType"].as_str() {
                    link["mimeType"] = json!(m);
                }
                content.push(link);
            }
        }
        return Ok(Value::Array(content));
    }
    if let Some(svg) = reply["svg"].as_str() {
        let svg = svg.to_string();
        let png = tokio::task::spawn_blocking(move || rasterize(&svg, width_px)).await.map_err(internal)??;
        result["image_px"] = json!([png.1, png.2]);
        return Ok(json!([
            { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&png.0), "mimeType": "image/png" },
            text_content(&result),
        ]));
    }
    Ok(json!([text_content(&result)]))
}

enum ScriptStep {
    /// run the code now in `args["code"]`; the note, if any, goes into the result
    Run(Option<Value>),
    /// nothing to run: this is the answer
    Done(Value),
}

/// The scripts kept with a project, newest first, for get_project.
async fn script_list(state: &AppState, p: &ProjectCtx) -> Vec<Value> {
    sqlx::query("SELECT name, length(code) AS n, updated_at FROM project_scripts WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 100")
        .bind(p.id).fetch_all(&state.pool).await.unwrap_or_default().iter()
        .map(|r| json!({ "name": r.get::<String, _>("name"), "characters": r.get::<i32, _>("n"), "updated": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at").to_rfc3339() }))
        .collect()
}

/// run_python's `script`, `edits`, `run` and `show`: load, change and save the named script, and leave the code to
/// run in `args["code"]`.
async fn stored_script(state: &AppState, caller: &Caller, p: &ProjectCtx, args: &mut Value) -> Result<ScriptStep, String> {
    const MAX: usize = 200_000;
    let run = args["run"].as_bool().unwrap_or(true);
    let show = args["show"].as_bool().unwrap_or(false);
    let given = args["code"].as_str().filter(|c| !c.trim().is_empty()).map(str::to_string);
    let edits = args["edits"].as_array().cloned().unwrap_or_default();
    let Some(script) = args["script"].as_str().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string) else {
        if !edits.is_empty() || !run || show {
            return Err("edits, run and show work on a stored script: give its name as `script`.".into());
        }
        return Ok(ScriptStep::Run(None));
    };
    if script.len() > 64 || !script.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err("A script name is up to 64 letters, digits, dots, dashes or underscores, for example \"schematic\" or \"board.v2\".".into());
    }
    let stored: Option<String> = sqlx::query_scalar("SELECT code FROM project_scripts WHERE project_id = $1 AND name = $2")
        .bind(p.id).bind(&script).fetch_optional(&state.pool).await.map_err(internal)?;
    let mut what = "run as stored";
    let mut code = match (given, stored) {
        (Some(code), old) => { what = if old.is_some() { "replaced" } else { "saved" }; code }
        (None, Some(old)) => old,
        (None, None) => {
            let names: Vec<String> = script_list(state, p).await.iter().filter_map(|s| s["name"].as_str().map(str::to_string)).collect();
            return Err(format!("{} has no script named \"{script}\".{} Send it once as `code` with this `script` name to store it.", p.name,
                if names.is_empty() { String::new() } else { format!(" Its scripts: {}.", names.join(", ")) }));
        }
    };
    for (i, e) in edits.iter().enumerate() {
        let (Some(old), Some(new)) = (e["old"].as_str(), e["new"].as_str()) else {
            return Err(format!("edit {}: give `old` (text now in the script) and `new` (what replaces it).", i + 1));
        };
        match code.matches(old).count() {
            0 => return Err(format!("edit {}: the script \"{script}\" has no text {:?}. Nothing was changed; run_python with show: true and run: false prints the script.", i + 1, clip_chars(old, 80))),
            1 => code = code.replacen(old, new, 1),
            n => return Err(format!("edit {}: {:?} occurs {n} times in \"{script}\"; give more of the text around it so it names one place. Nothing was changed.", i + 1, clip_chars(old, 80))),
        }
        what = "edited";
    }
    if code.len() > MAX {
        return Err("The script is too long (200,000 characters at most).".into());
    }
    if what != "run as stored" {
        sqlx::query("INSERT INTO project_scripts (project_id, name, code, updated_by) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (project_id, name) DO UPDATE SET code = EXCLUDED.code, updated_by = EXCLUDED.updated_by, updated_at = now()")
            .bind(p.id).bind(&script).bind(&code).bind(caller.user.id).execute(&state.pool).await.map_err(internal)?;
    }
    let mut note = json!({ "name": script, "characters": code.chars().count(), "state": what });
    if show {
        note["code"] = json!(code);
    }
    if !run {
        return Ok(ScriptStep::Done(json!({ "ok": true, "ran": false, "script": note })));
    }
    args["code"] = json!(code);
    for k in ["script", "edits", "run", "show"] {
        if let Some(o) = args.as_object_mut() { o.remove(k); }
    }
    Ok(ScriptStep::Run(Some(note)))
}

fn clip_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}...", s.chars().take(n).collect::<String>()) }
}

async fn store_change(state: &AppState, caller: &Caller, p: &ProjectCtx, record: &Value) -> AppResult<i64> {
    let doc_id: Uuid = record["docId"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| anyhow::anyhow!("change record without a document"))?;
    let undo = Some(&record["undo"]).filter(|u| u.to_string().len() <= MAX_UNDO_BYTES);
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO mcp_changes (user_id, project_id, doc_id, title, edits, undo, client) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(caller.user.id)
    .bind(p.id)
    .bind(doc_id)
    .bind(record["title"].as_str().unwrap_or(""))
    .bind(&record["edits"])
    .bind(undo)
    .bind(&caller.client)
    .fetch_one(&state.pool)
    .await?;
    trim_undo(&state.pool).await?;
    Ok(id)
}

/// How many of a person's newest changes to a project can still be taken back, and for how long.
const UNDO_KEPT: i64 = 20;
const UNDO_DAYS: i32 = 7;

/// An undo is for the recent past; the record of what was changed stays.  A whole-board change keeps
/// about a megabyte of undo, so only each person's newest changes to a project hold theirs.
pub(crate) async fn trim_undo(pool: &sqlx::PgPool) -> sqlx::Result<u64> {
    let done = sqlx::query(
        "UPDATE mcp_changes SET undo = NULL
         WHERE undo IS NOT NULL
           AND (created_at < now() - make_interval(days => $2)
                OR id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY user_id, project_id ORDER BY id DESC) AS n
                                          FROM mcp_changes) newest WHERE n > $1))",
    )
    .bind(UNDO_KEPT)
    .bind(UNDO_DAYS)
    .execute(pool)
    .await?;
    Ok(done.rows_affected())
}

/// SVG to PNG, the longest side `longest` pixels.  The picture carries its text as paths
/// (web/domains/pcb/mcp/picture.ts), so no fonts are needed.
pub(crate) fn rasterize(svg: &str, longest: u32) -> Result<(Vec<u8>, u32, u32), String> {
    use resvg::{tiny_skia, usvg};
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).map_err(|e| format!("The picture could not be drawn ({e})."))?;
    let size = tree.size();
    let scale = longest as f32 / size.width().max(size.height()).max(1.0);
    let (w, h) = (((size.width() * scale).ceil() as u32).max(1), ((size.height() * scale).ceil() as u32).max(1));
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("The picture is too large to draw.")?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let png = pixmap.encode_png().map_err(|e| format!("The picture could not be encoded ({e})."))?;
    Ok((png, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_complete_and_well_formed() {
        let tools = catalog();
        let names: Vec<&str> = tools.iter().map(|t| t.def["name"].as_str().unwrap()).collect();
        for want in ["list_projects", "get_design_overview", "list_components", "run_checks", "render_view", "apply_changes", "undo_changes", "add_comment", "highlight", "get_selection", "trace_net", "export_fab"] {
            assert!(names.contains(&want), "{want} is missing");
        }
        // What only makes sense inside the editor is not offered.
        for gone in ["focus_view", "open_document", "propose_changes", "list_plugin_tools", "call_plugin_tool"] {
            assert!(!names.contains(&gone), "{gone} should not be offered");
        }
        let mut seen = std::collections::HashSet::new();
        for t in tools {
            let name = t.def["name"].as_str().unwrap();
            assert!(seen.insert(name), "{name} is listed twice");
            assert!(t.def["description"].as_str().is_some_and(|d| d.len() > 40), "{name} needs a real description");
            assert_eq!(t.def["inputSchema"]["type"], "object", "{name}");
            assert!(t.def["inputSchema"]["properties"].get("doc").is_none(), "{name} still takes doc");
            assert_eq!(t.project, t.def["inputSchema"]["properties"].get("project").is_some(), "{name}");
            if t.project {
                assert!(t.def["inputSchema"]["required"].as_array().is_some_and(|r| r.contains(&json!("project"))), "{name} must require project");
            }
            assert_eq!(t.def["annotations"]["readOnlyHint"], !t.write, "{name}");
        }
    }

    #[test]
    fn cad_tools_are_listed_only_with_cad_on() {
        let names = |write: bool, cad: bool| listed(write, cad).map(|t| t.def["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let (off, on) = (names(true, false), names(true, true));
        assert!(on.iter().any(|n| n == "cad_get_features") && on.iter().any(|n| n == "cad_edit_features"), "{on:?}");
        assert!(!off.iter().any(|n| n.starts_with("cad_")), "{off:?}");
        // nothing else changes with the setting
        assert_eq!(off, on.iter().filter(|n| !n.starts_with("cad_")).cloned().collect::<Vec<_>>());
        assert!(!names(false, true).contains(&"cad_edit_features".to_string()), "a read-only app is not shown a CAD edit");
        for t in catalog() {
            assert_eq!(t.cad, t.def["name"].as_str().unwrap().starts_with("cad_"), "{}", t.def["name"]);
        }
        assert!(!INSTRUCTIONS.contains("cad_") && CAD_INSTRUCTIONS.contains("cad_get_features"));
        // the assembly's tools are Mechanical CAD's too, and every cad tool the instructions name exists
        assert!(on.iter().any(|n| n == "cad_edit_assembly") && on.iter().any(|n| n == "cad_render_view"), "{on:?}");
        for word in CAD_INSTRUCTIONS.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).filter(|w| w.starts_with("cad_") && w.len() > 4) {
            assert!(on.iter().any(|n| n == word), "the instructions name {word}, which is not a tool");
        }
        // the document argument speaks of several PCBs only to a person with CAD on (the project shell comes with it)
        let doc_desc = |cad: bool| listed(true, cad).find(|t| t.def["name"] == "get_component").map(|t| def_for(t, cad)).unwrap()["inputSchema"]["properties"]["document"]["description"].as_str().unwrap().to_string();
        assert_eq!(doc_desc(false), DOCUMENT_DESC);
        assert!(doc_desc(true).starts_with(DOCUMENT_DESC) && doc_desc(true).contains("several PCBs"));
    }

    #[test]
    fn apply_changes_carries_every_edit_of_the_assistant() {
        let apply = catalog().iter().find(|t| t.def["name"] == "apply_changes").unwrap();
        let text = apply.def["description"].as_str().unwrap();
        for op in ["set_field", "add_symbol", "add_wire", "update_from_schematic", "auto_place", "autoroute", "set_rules", "add_item"] {
            assert!(text.contains(op), "{op}");
        }
        assert!(!text.contains("proposal") && !text.contains("propose") && !text.contains("card"), "apply_changes must not speak of proposals");
        assert!(apply.def["inputSchema"]["properties"]["edits"]["items"]["properties"]["op"]["enum"].as_array().unwrap().len() >= 16);
        assert!(apply.write);
    }

    #[test]
    fn guide_topics() {
        assert!(guide("").unwrap().contains("## Reviewing a design"));
        let routing = guide("routing").unwrap();
        assert!(routing.starts_with("## Working on a design") && routing.contains("## Routing a board") && !routing.contains("## Reviewing a design"));
        assert!(routing.contains("## Laying out a board by the physics"));
        let layout = guide("layout").unwrap();
        assert!(layout.contains("board.plan(") && layout.contains("board.stackup(") && !layout.contains("## Routing a board"));
        let quick = guide("quick").unwrap();
        assert!(quick.starts_with("## A board in one call") && quick.contains("board.design(") && !quick.contains("## Drawing schematics") && quick.len() < 4000, "{}", quick.len());
        assert!(guide("nope").is_err());
    }

    #[test]
    fn picture_is_rasterised_to_the_asked_size() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20"><rect width="40" height="20" fill="#001023"/><path d="M2 2L38 18" stroke="#C83434" stroke-width="1" fill="none"/></svg>"##;
        let (png, w, h) = rasterize(svg, 800).unwrap();
        assert_eq!((w, h), (800, 400));
        assert_eq!(&png[1..4], b"PNG");
    }

    #[test]
    fn prompts_fill_in_their_arguments() {
        let p = prompt_get(&json!({ "name": "review_design", "arguments": { "project": "amp" } })).unwrap();
        assert!(p["messages"][0]["content"]["text"].as_str().unwrap().contains("project amp"));
        assert!(prompt_get(&json!({ "name": "nope" })).is_err());
    }

    #[test]
    fn cad_prompts_and_resources_follow_the_setting() {
        let names = |cad: bool| prompts_list(cad)["prompts"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert!(names(true).contains(&"design_bracket".to_string()) && names(true).contains(&"make_assembly".to_string()));
        assert!(!names(false).iter().any(|n| CAD_PROMPTS.iter().any(|p| p.0 == n)), "CAD prompts are not offered with CAD off");
        assert_eq!(names(false), PROMPTS.iter().map(|p| p.0.to_string()).collect::<Vec<_>>());
        let p = prompt_get(&json!({ "name": "design_bracket", "arguments": { "project": "rig", "description": "an L bracket for two M5 screws" } })).unwrap();
        let text = p["messages"][0]["content"]["text"].as_str().unwrap();
        assert!(text.contains("project rig") && text.contains("two M5 screws") && text.contains("cad_reference"));
        let uris = |cad: bool| resources(cad).iter().map(|r| r["uri"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert!(uris(true).contains(&"junction://cad/guide".to_string()) && uris(true).contains(&"junction://cad/features".to_string()));
        assert_eq!(uris(false), vec!["junction://guide/electronics".to_string()]);
        assert_eq!(export_mime("Hinged box.step"), "model/step");
        assert_eq!(export_mime("plate.DXF"), "image/vnd.dxf");
        assert_eq!(export_mime("thing"), "application/octet-stream");
    }

    #[test]
    fn domain_tools_say_what_they_do() {
        let find = |name: &str| catalog().iter().find(|t| t.def["name"] == name).unwrap_or_else(|| panic!("{name} is missing"));
        assert_eq!(find("cad_edit_assembly").def["annotations"]["destructiveHint"], true);
        assert_eq!(find("cad_get_assembly").def["annotations"]["readOnlyHint"], true);
        assert_eq!(find("cad_export").def["annotations"]["idempotentHint"], false, "an export leaves a file behind each time");
        assert_eq!(find("cad_search_models").def["annotations"]["openWorldHint"], true);
        assert!(find("cad_search_models").cad && !find("cad_search_models").project);
    }
}
