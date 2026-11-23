// pcbdialogs — the board editor's dialogs that are more than one item's properties: Board Setup,
// Update PCB from Schematic, Edit Footprint Fields, the DRC dialog, Board Statistics, Net Inspector and
// Clearance Resolution.  Each is a module action on CollabTools.pcb, so the menus (web/actions/tables.ts)
// and hotkeys find it the way they find every other board command.
import { installTransformDialogs } from "./transform-dialogs";
import { openBoardSetup } from "./board-setup";
import "./find";   // Edit > Find (DIALOG_FIND): registers E.hooks.boardFind / boardFindNext
import { openExportVrml } from "./vrml";
import { openFindByProperties } from "./find-by-props";
import { exportCmpFile, exportHyperlynx, generateBomLegacy, generateD356, generateFootprintReport } from "./fab-reports";
import { openFootprintFields } from "./fp-fields";
import { clearDrcMarkers, drcReport, excludeMarker, nextMarker, openBoardStatistics, openClearance, openConstraints, openDiffFootprint, openFootprintAssociations, openDrc, prevMarker } from "./inspect";
import { showPane } from "../panes";
import { carriedFootprintDialog, fpFieldDialog, newShapeDialog, newTextDialog, newZoneDialog, openZoneManager, pcbItemDialog } from "./item-props";
import { tracksOnly, trackViaDialog } from "./track-via";
import { newTextBoxDialog } from "./textbox";
import { newDimensionDialog } from "./dimension";
import { convertSettingsDialog } from "./convert";
import { newBarcodeDialog } from "./barcode";
import { newTableDialog } from "./table";
import { createArrayDialog } from "./array";
import { padPropertiesDialog } from "./pad-props";
import { openExchangeFootprints } from "./exchange";
import { openGlobalDeletions } from "./global-delete";
import { openTextAndGraphics } from "./text-graphics";
import { openUnusedPads } from "./unused-pads";
import { openCleanupGraphics } from "./cleanup-graphics";
import { openEditTeardrops } from "./teardrops";
import { openGlobalEditTracks } from "./global-tracks";
import { openFilterSelection } from "./filter-selection";
import { booleanPolygons, chamferLines, extendLines, filletLines, outsetItems, simplifyPolygons } from "./shape-modify";
import { repairBoard } from "./repair";
import { collectAndEmbed3DModels, embeddedCountMessage } from "./embed-models";
import { E } from "../state";
import { sendOp } from "../net";
import { applyChanges } from "../doc";
import { toast } from "../util";
import { openReannotate } from "./reannotate";
import { openUpdatePcb, projectNetlist, updatePcbFromSchematicEditor } from "./update-pcb";
import { openImportNetlist } from "./import-netlist";
import { importSpecctraSession } from "./specctra-session";
import { migrate3DModels } from "./migrate-3d-models";
import { noteCommit, runZoneFill, zoneFillAll, zoneFillSelected } from "./zonefill";
import { commitObservers, toolCtx } from "../tools";
import { installBoardCommitHooks } from "./board-commit";
import { clearStitchViaExclusions, excludeStitchVia, newViaStitchDialog } from "./via-stitch";
import { openVertexEditor } from "./vertex-editor";
import { applyDesignBlockLayout, expandSelection, generatePlacementRuleAreas, installMultichannel, repeatLayout, unlinkLayout, updateLinkedLayouts } from "./multichannel";

type Run = (ctx: ToolCtx) => void | boolean;
function action(id: string, label: string, key: string, run: Run): void {
  const pcb = CollabTools.pcb as ToolModule | undefined; if (!pcb) return;
  pcb.actions = { ...(pcb.actions || {}) };          // the module's own table is frozen: ours is a copy with these added
  pcb.actions[id] = { label, key: key || null, run: (ctx) => { run(ctx); } };
}

/** Wire the dialogs into the board tools.  Runs once they are loaded (pcbtools-loader.ts announces it): at start-up they are not. */
let installed = false;
export function installPcbDialogs(): void {
  if (installed || typeof CollabTools === "undefined" || !CollabTools.pcb) return;
  installed = true;
  if (typeof KDialogs !== "undefined" && KDialogs) { const kd = KDialogs as KDialogsApi & { pcbItemDialog?: typeof pcbItemDialog; pcbFieldDialog?: typeof fpFieldDialog }; kd.pcbItemDialog = pcbItemDialog; kd.pcbFieldDialog = fpFieldDialog; }   // KDialogs.openItem / openField ask them first
  if (typeof KDialogs !== "undefined" && KDialogs) KDialogs.pcbSelectionDialog = (ctx, items) => tracksOnly(items) && trackViaDialog(ctx, items);
  (CollabTools.pcb as ToolModule & { padProperties?: unknown }).padProperties = padPropertiesDialog;
  installTransformDialogs();   // Move Item, Position Relative, Swap Layers, Cleanup Tracks and Vias   // DIALOG_PAD_PROPERTIES in place of the module's short form
  Object.assign(CollabTools.pcb as object, { drcReport, projectNetlist });   // the DRC dialog's run and the project's netlist as data (plugins' kicad-cli)
  const nd = (CollabTools.pcb as ToolModule & { setNewItemDialogs?(d: Record<string, unknown>): void }).setNewItemDialogs;
  // CONVERT_TOOL's Conversion Settings dialog
  const cd = (CollabTools.pcb as ToolModule & { setConvertDialogs?(d: { settings?: typeof convertSettingsDialog }): void }).setConvertDialogs;
  if (cd) cd({ settings: convertSettingsDialog });
  if (nd) nd({ barcode: newBarcodeDialog, gr_text: newTextDialog, gr_text_box: newTextBoxDialog, table: newTableDialog, zone: newZoneDialog, viaStitch: newViaStitchDialog, shape: newShapeDialog, dimension: newDimensionDialog, footprint: carriedFootprintDialog });   // footprint: a microwave footprint being placed (E)   // Add Text, Draw Text Box and Draw Zone / Rule Area open their properties dialog first
  action("excludeStitchVia", "Exclude From Stitching", "", excludeStitchVia);   // VIA_STITCH_TOOL::ExcludeStitchVia
  action("clearStitchViaExclusions", "Clear Via Stitching Exclusions", "", clearStitchViaExclusions);
  action("createArray", "Create Array...", "", (ctx) => { createArrayDialog(ctx); });   // PCB_ACTIONS::createArray (ARRAY_TOOL)
  action("boardSetup", "Board Setup...", "", (ctx) => { void openBoardSetup(ctx); });
  action("zonesManager", "Zone Manager...", "", (ctx) => { openZoneManager(ctx); });   // GLOBAL_EDIT_TOOL::ZonesManager (Tools > Zone Manager...)
  action("zoneManager", "Zone Manager...", "", (ctx) => { openZoneManager(ctx); });
  action("cleanupGraphics", "Cleanup Graphics...", "", openCleanupGraphics);   // GLOBAL_EDIT_TOOL::CleanupGraphics
  action("editTracksAndVias", "Edit Track & Via Properties...", "", openGlobalEditTracks);   // GLOBAL_EDIT_TOOL::EditTracksAndVias
  action("exportVRML", "VRML...", "", (ctx) => { void openExportVrml(ctx); });   // BOARD_EDITOR_CONTROL::ExportVRML
  action("exportCmpFile", "Footprint Association (.cmp) File...", "", (ctx) => { void exportCmpFile(ctx); });
  action("generateD356File", "IPC-D-356 Netlist File...", "", (ctx) => { void generateD356(ctx); });
  action("generateReportFile", "Footprint Report...", "", (ctx) => { void generateFootprintReport(ctx); });
  action("generateBOMLegacy", "Bill of Materials (legacy)...", "", (ctx) => { void generateBomLegacy(ctx); });
  action("exportHyperlynx", "Hyperlynx...", "", (ctx) => { void exportHyperlynx(ctx); });
  action("filterSelection", "Filter Selected Items...", "", openFilterSelection);   // PCB_SELECTION_TOOL::filterSelection
  // EDIT_TOOL's Shape Modification sub-menu
  action("findByProperties", "Find by Properties...", "", openFindByProperties);   // PCB_EDIT_FRAME::ShowFindByPropertiesDialog
  action("outsetItems", "Outset Items...", "", outsetItems);   // CONVERT_TOOL::OutsetItems
  action("filletLines", "Fillet Lines...", "", filletLines);
  action("chamferLines", "Chamfer Lines...", "", chamferLines);
  action("extendLines", "Extend Lines to Meet", "", extendLines);
  action("simplifyPolygons", "Simplify Polygons", "", simplifyPolygons);
  action("mergePolygons", "Merge Polygons", "", booleanPolygons("mergePolygons"));
  action("subtractPolygons", "Subtract Polygons", "", booleanPolygons("subtractPolygons"));
  action("intersectPolygons", "Intersect Polygons", "", booleanPolygons("intersectPolygons"));
  action("editTeardrops", "Edit Teardrops...", "", openEditTeardrops);   // GLOBAL_EDIT_TOOL::EditTeardrops
  action("repairBoard", "Repair Board", "", repairBoard);   // BOARD_EDITOR_CONTROL::RepairBoard
  action("collect3DModels", "Collect And Embed 3D Models", "", (ctx) => { void embed3DModels(ctx); });   // PCB_CONTROL::CollectAndEmbed3DModels
  action("boardReannotate", "Geographical Reannotate...", "", openReannotate);   // BOARD_REANNOTATE_TOOL::ShowReannotateDialog
  action("removeUnusedPads", "Remove Unused Pads...", "", openUnusedPads);   // GLOBAL_EDIT_TOOL::RemoveUnusedPads
  action("updatePcbFromSchematic", "Update PCB from Schematic...", "F8", (ctx) => { void openUpdatePcb(ctx); });
  // MULTICHANNEL_TOOL (Tools > Multi-Channel and the selection menu's Multi-Channel sub-menu) and PCB_CONTROL::ApplyDesignBlockLayout
  action("generatePlacementRuleAreas", "Generate Placement Rule Areas...", "", generatePlacementRuleAreas);
  action("repeatLayout", "Repeat Layout...", "", (ctx) => { void repeatLayout(ctx); });
  action("updateLinkedLayouts", "Update Linked Layouts", "", (ctx) => { void updateLinkedLayouts(ctx); });
  action("unlinkLayout", "Unlink Layout", "", unlinkLayout);
  action("expandToMatchingTopology", "Expand Selection by One Step", "", (ctx) => expandSelection(ctx, false));
  action("expandToLargestTopology", "Expand Selection to Largest Matching Topology", "", (ctx) => expandSelection(ctx, true));
  action("applyDesignBlockLayout", "Apply Design Block Layout", "", (ctx) => { void applyDesignBlockLayout(ctx); });
  installMultichannel();
  action("importNetlist", "Netlist...", "", (ctx) => { openImportNetlist(ctx); });
  action("importSpecctraSession", "Specctra Session...", "", (ctx) => { void importSpecctraSession(ctx); });
  action("migrate3DModels", "Migrate 3D Models...", "", (ctx) => { void migrate3DModels(ctx); });
  // GLOBAL_EDIT_TOOL::ExchangeFootprints (DIALOG_EXCHANGE_FOOTPRINTS)
  action("updateFootprint", "Update Footprint...", "", (ctx) => { openExchangeFootprints(ctx, "updateFootprint"); });
  action("updateFootprints", "Update Footprints from Library...", "", (ctx) => { openExchangeFootprints(ctx, "updateFootprints"); });
  action("changeFootprint", "Change Footprint...", "", (ctx) => { openExchangeFootprints(ctx, "changeFootprint"); });
  action("changeFootprints", "Change Footprints...", "", (ctx) => { openExchangeFootprints(ctx, "changeFootprints"); });
  action("editTextAndGraphics", "Edit Text & Graphics Properties...", "", openTextAndGraphics);   // GLOBAL_EDIT_TOOL::EditTextAndGraphics
  action("globalDeletions", "Global Deletions...", "", openGlobalDeletions);   // GLOBAL_EDIT_TOOL::GlobalDeletions
  action("editFootprintFields", "Bulk Edit Footprint Fields...", "", openFootprintFields);
  action("runDRC", "Design Rules Checker", "", openDrc);
  action("clearMarkers", "Clear DRC Markers", "", clearDrcMarkers);
  action("prevMarker", "Previous Marker", "", prevMarker);
  action("nextMarker", "Next Marker", "", nextMarker);
  action("excludeMarker", "Exclude Marker", "", () => excludeMarker());
  // View > Panels > Net Inspector: the docked panel (PCB_EDIT_FRAME's m_netInspectorPanel), a check item
  action("netInspector", "Net Inspector", "", () => showPane("netinsp"));
  action("showNetInspector", "Net Inspector", "", () => showPane("netinsp"));
  // View > Panels > Geometric Constraints: PCB_EDIT_FRAME's docked PANEL_CONSTRAINTS (the footprint editor keeps the dialog)
  action("showConstraintsPanel", "Geometric Constraints", "", () => showPane("constraints"));
  // EDIT_TOOL::EditVertices: the Edit Vertices pane for the one selected zone or polygon
  action("editVertices", "Edit Corners...", "", () => { openVertexEditor(); });
  action("boardStatistics", "Board Statistics", "", openBoardStatistics);
  action("inspectClearance", "Clearance Resolution", "", openClearance);
  action("inspectConstraints", "Constraints Resolution", "", openConstraints);
  action("showFootprintAssociations", "Show Footprint Associations", "", openFootprintAssociations);
  action("diffFootprint", "Compare Footprint with Library", "", openDiffFootprint);
  // ZONE_FILLER_TOOL: the browser's own filler (web/domains/pcb/fab/zonefill.ts)
  action("zoneFillAll", "Fill All Zones", "B", zoneFillAll);
  action("zoneFill", "Draft Fill Selected Zone(s)", "", zoneFillSelected);
  (window as unknown as { PcbZoneFill: unknown }).PcbZoneFill = { fillAll: zoneFillAll, fillSelected: zoneFillSelected, run: runZoneFill };
  installBoardCommitHooks();
  commitObservers.push((phase, changes, label) => noteCommit(phase, changes as KChange[], label, () => toolCtx({}) as ToolCtx));
}
/** The schematic editor's Tools > Update PCB from Schematic… (F8) opens the board and runs the same dialog there. */
function installSchActions(): void {
  if (typeof CollabTools === "undefined") return;
  const sch = CollabTools.sch as (ToolModule & { actions?: Record<string, unknown> }) | undefined;
  if (sch && sch.actions) (sch.actions as Record<string, unknown>).updatePcbFromSchematic = { id: "updatePcbFromSchematic", label: "Update PCB from Schematic...", key: "F8", run: (ctx: ToolCtx) => { void updatePcbFromSchematicEditor(ctx); return true; } };
}
installPcbDialogs();
window.addEventListener("kc-pcb-tools", installPcbDialogs);
installSchActions();

/**
 * PCB_CONTROL::CollectAndEmbed3DModels (embed-models.ts): the board's new files first (BOARD::GetEmbeddedFiles()->AddFile,
 * outside the commit), then the footprints' model paths as one "Embed 3D Models" step, and the info bar's count for 5 s.
 */
async function embed3DModels(ctx: ToolCtx): Promise<void> {
  const doc = E.kdoc as (KDoc & { embeddedFiles?: SNode | null }) | null;
  if (!doc || doc.type !== "pcb" || (doc as { fpEditor?: boolean }).fpEditor) return;
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const projectModel = (globalThis as { KiCadProjectModel?: (stem: string, ext?: string) => string | null }).KiCadProjectModel || null;
  const r = await collectAndEmbed3DModels(doc.items.values() as Iterable<{ id: string; kind: string; node: SNode }>, doc.embeddedFiles, async (url) => {
    const res = await fetch(url, { credentials: "same-origin" }); return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }, projectModel);
  if (E.kdoc !== doc || r.count <= 0) return;
  const PT = (window as unknown as { PcbTools: { replacedChange(item: unknown, node: SNode): KChange } }).PcbTools;
  if (r.files.length) { const change = (KiCadCanvas as unknown as { boardSetup: { embeddedFilesChange(files: string[]): KChange } }).boardSetup.embeddedFilesChange(r.files); sendOp([change], false); applyChanges([change]); }
  const changes: KChange[] = [];
  for (const f of r.footprints) { const it = doc.items.get(f.id); if (it) changes.push(PT.replacedChange(it, f.node as SNode)); }
  if (changes.length) { ctx.commit(changes, "Embed 3D Models"); ctx.requestRender(); }
  toast(embeddedCountMessage(r.count), 5000);
}
