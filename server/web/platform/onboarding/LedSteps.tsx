// LedSteps.tsx — what each step of Help > Make an LED Board says: a resistor, an LED and a two-pin
// connector, from an empty schematic to the files a board house takes.  The panel (Guide.tsx) shows
// the current step; editor/tutorial.ts tells it when the project shows the step done.
import type { ReactNode } from "react";
import { dispatch, useApp } from "../../shared/store";

function Key({ children }: { children: ReactNode }) { return <span className="kbd">{children}</span>; }
function Tick({ on, children }: { on: boolean; children: ReactNode }) {
  return <li style={{ listStyle: "none", opacity: on ? 0.6 : 1 }}>{on ? "✓ " : "○ "}{children}</li>;
}

const run = (id: string) => dispatch({ type: "action", id });
const show = (docId: string | undefined) => { if (docId) dispatch({ type: "openDoc", docId }); };

interface Ctx { editor: string | null | undefined; sch?: string; pcb?: string; viewOnly: boolean }

/** The body of each LED tutorial step. */
export function LedBodies({ editor, sch, pcb, viewOnly }: Ctx): Record<string, ReactNode> {
  return {
    ledSchematic: <LedSchematic sch={sch} />,
    ledParts: <LedParts editor={editor} sch={sch} />,
    ledWire: <LedWire editor={editor} sch={sch} />,
    ledFootprints: <LedFootprints editor={editor} sch={sch} viewOnly={viewOnly} />,
    ledUpdate: <LedUpdate editor={editor} pcb={pcb} viewOnly={viewOnly} />,
    ledOutline: <LedOutline editor={editor} pcb={pcb} />,
    ledPlace: <LedPlace editor={editor} pcb={pcb} />,
    ledRoute: <LedRoute editor={editor} pcb={pcb} viewOnly={viewOnly} />,
    ledCheck: <LedCheck editor={editor} pcb={pcb} />,
    ledFab: <LedFab editor={editor} pcb={pcb} />,
  };
}

const OpenSch = ({ sch }: { sch?: string }) => <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => show(sch)} disabled={!sch}>Open the schematic</button></div>;
const OpenPcb = ({ pcb }: { pcb?: string }) => <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => show(pcb)} disabled={!pcb}>Open the board</button></div>;

function LedSchematic({ sch }: { sch?: string }) {
  return (
    <>
      <p>You are going to make a small board that lights an LED from a 5 V supply: a connector brings the power in, a resistor limits the current, and the LED lights.</p>
      <p>Everything starts in the schematic, the drawing of what connects to what.</p>
      <OpenSch sch={sch} />
    </>
  );
}

function LedParts({ editor, sch }: { editor: Ctx["editor"]; sch?: string }) {
  const f = useApp((s) => s.tutorial);
  if (editor !== "sch") return <><p>Go back to the schematic to place the parts.</p><OpenSch sch={sch} /></>;
  return (
    <>
      <p>Press <Key>A</Key> to add a symbol, type its name in the search box, pick it and click to drop it on the sheet. <Key>R</Key> rotates it while it is on the cursor.</p>
      <ul style={{ padding: 0, margin: "6px 0" }}>
        <Tick on={!!f?.conn}><b>Conn_01x02</b>, a two-pin connector for the power</Tick>
        <Tick on={!!f?.r}><b>R</b>, the resistor</Tick>
        <Tick on={!!f?.led}><b>LED</b></Tick>
      </ul>
      <p className="kg-hint">Click a placed resistor, press <Key>E</Key> and set its Value to 330Ω: with 5 V and a red LED that is about 10 mA.</p>
    </>
  );
}

function LedWire({ editor, sch }: { editor: Ctx["editor"]; sch?: string }) {
  const f = useApp((s) => s.tutorial);
  if (editor !== "sch") return <><p>Go back to the schematic to wire the parts.</p><OpenSch sch={sch} /></>;
  return (
    <>
      <p>Press <Key>W</Key>, click a pin's end, and click the pin you want to reach (click in between to turn a corner). Draw three wires to close the loop:</p>
      <ol style={{ margin: "6px 0 6px 18px" }}>
        <li>connector pin 1 to the resistor</li>
        <li>the resistor's other end to the LED's anode (A, the triangle's flat side)</li>
        <li>the LED's cathode (K, the bar) back to connector pin 2</li>
      </ol>
      {f ? <p className="kg-count" aria-live="polite"><b>{f.wired}</b> of 3 parts fully wired.</p> : null}
      <p className="kg-hint">A pin that is not connected yet shows a small square on its end.</p>
    </>
  );
}

function LedFootprints({ editor, sch, viewOnly }: { editor: Ctx["editor"]; sch?: string; viewOnly: boolean }) {
  const f = useApp((s) => s.tutorial);
  if (editor !== "sch") return <><p>Go back to the schematic for this step.</p><OpenSch sch={sch} /></>;
  return (
    <>
      <p>Each part needs a name (R1, D1, J1) and a footprint: the copper pads it is soldered to on the board.</p>
      <ul style={{ padding: 0, margin: "6px 0" }}>
        <Tick on={!!f?.named}>Annotate gives every part its name</Tick>
        <Tick on={!!f?.footprints}>Assign Footprints picks the pads. Good first choices: <span className="mono">Resistor_SMD:R_0805_2012Metric</span>, <span className="mono">LED_SMD:LED_0805_2012Metric</span>, <span className="mono">Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical</span></Tick>
      </ul>
      <div className="kg-acts">
        <button type="button" className="btn primary sm" onClick={() => run("module:annotate")} disabled={viewOnly}>Annotate</button>
        <button type="button" className="btn sm" onClick={() => run("module:assignFootprints")} disabled={viewOnly}>Assign Footprints</button>
      </div>
      <p className="kg-hint">You can also click a part, press <Key>E</Key> and fill in its Footprint field.</p>
    </>
  );
}

function LedUpdate({ editor, pcb, viewOnly }: { editor: Ctx["editor"]; pcb?: string; viewOnly: boolean }) {
  const f = useApp((s) => s.tutorial);
  return (
    <>
      <p>Now the board. Update PCB from Schematic (<Key>F8</Key>) brings the three footprints over, with thin lines (the ratsnest) showing what must connect.</p>
      {f && f.onBoard ? <p className="kg-count"><b>{f.onBoard}</b> of 3 footprints on the board{f.stale ? ", and the schematic has changes it does not have yet" : ""}.</p> : null}
      {editor === "pcb"
        ? <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => run("module:updatePcbFromSchematic")} disabled={viewOnly}>Update PCB from Schematic</button></div>
        : <OpenPcb pcb={pcb} />}
      <p className="kg-hint">The footprints arrive on the cursor: click to drop them.</p>
    </>
  );
}

function LedOutline({ editor, pcb }: { editor: Ctx["editor"]; pcb?: string }) {
  if (editor !== "pcb") return <><p>Open the board to draw its outline.</p><OpenPcb pcb={pcb} /></>;
  return (
    <>
      <p>The outline is the shape the board house cuts. Pick the <b>Edge.Cuts</b> layer in the layer box or the Appearance panel, then choose Place › Draw Rectangle and drag a rectangle about 20 × 15 mm.</p>
      <div className="kg-acts">
        <button type="button" className="btn primary sm" onClick={() => { dispatch({ type: "setActiveLayer", layer: "Edge.Cuts" }); dispatch({ type: "setTool", tool: "grect" }); }}>Edge.Cuts rectangle</button>
      </div>
      <p className="kg-hint">Leave a little room around the parts: copper too close to the edge is a DRC error.</p>
    </>
  );
}

function LedPlace({ editor, pcb }: { editor: Ctx["editor"]; pcb?: string }) {
  const f = useApp((s) => s.tutorial);
  if (editor !== "pcb") return <><p>Open the board to place the footprints.</p><OpenPcb pcb={pcb} /></>;
  return (
    <>
      <p>Hover a footprint and press <Key>M</Key> to move it, <Key>R</Key> to rotate it. Put all three inside the outline, the resistor between the connector and the LED, so the ratsnest lines are short and do not cross.</p>
      {f ? <p className="kg-count"><b>{f.inside}</b> of 3 inside the outline.</p> : null}
    </>
  );
}

function LedRoute({ editor, pcb, viewOnly }: { editor: Ctx["editor"]; pcb?: string; viewOnly: boolean }) {
  const f = useApp((s) => s.tutorial);
  if (editor !== "pcb") return <><p>Open the board to route it.</p><OpenPcb pcb={pcb} /></>;
  return (
    <>
      {f && f.open ? <p className="kg-count" aria-live="polite"><b>{f.open}</b> {f.open === 1 ? "connection" : "connections"} left to route.</p> : null}
      <p>Press <Key>X</Key>, click a pad at one end of a thin line, click where the track should turn, and click the pad at the other end. <Key>Esc</Key> stops.</p>
      <div className="kg-acts">
        <button type="button" className="btn primary sm" onClick={() => dispatch({ type: "setTool", tool: "route" })} disabled={viewOnly}>Route Tracks</button>
      </div>
      <p className="kg-hint">0.25 mm tracks are plenty for 10 mA.</p>
    </>
  );
}

function LedCheck({ editor, pcb }: { editor: Ctx["editor"]; pcb?: string }) {
  if (editor !== "pcb") return <OpenPcb pcb={pcb} />;
  return (
    <>
      <p>The Design Rules Checker finds what a board house would send back: tracks too close, something left unconnected, copper too near the edge. Fix what it lists and run it again until it is clean.</p>
      <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => run("module:runDRC")}>Run the checker</button></div>
    </>
  );
}

function LedFab({ editor, pcb }: { editor: Ctx["editor"]; pcb?: string }) {
  if (editor !== "pcb") return <OpenPcb pcb={pcb} />;
  return (
    <>
      <p>A board house makes the board from Gerber files (one per layer) and a drill file. Fabrication Outputs writes them all into one zip.</p>
      <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => run("fabPackage")}>Fabrication Outputs</button></div>
      <p className="kg-hint">It is in the menus as File › Fabrication Outputs.</p>
    </>
  );
}
