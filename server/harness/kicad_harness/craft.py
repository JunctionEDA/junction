"""The whole board in one call, and a review that costs few tokens.

`board.design(...)` runs a layout in the order a careful designer works (Phil's Lab's board walk-throughs, and the
order of work in server/docs/pcb-design-rules.md): plan from the netlist, stackup, placement by how critical each
part is, ground on every layer that carries it, antenna keep-outs, routing with the critical nets first and the
supplies last, the copper the physics still owes (fences, thermal vias, a via for every ground pad, stitching),
clean-up, silkscreen, and the review.  It only calls what the harness already has, with the defaults a board should
get, and hands back one short result, so a model does not carry the rules or nine results in its context.

`board.brief()` is the review as one line per finding: the rule, the first sentence and the items.
"""
from __future__ import annotations

from .transport import HarnessError

# what a four-layer board's inner layers carry: signal / ground / ground / signal keeps a tight, unbroken reference
# under both routing layers and gives every via a return path one layer away
INNER_GROUND = ("In1.Cu", "In2.Cu")


def _short(row: str, items: int = 6) -> str:
    """A review finding as one line: "level rule: first sentence. [items]"."""
    head, _, rest = row.partition(": ")
    text, _, tail = rest.partition(" [")
    first = text.split(". ")[0].rstrip(".")
    if tail:
        parts = tail.rstrip("]").split("; ")
        tail = " [" + "; ".join(parts[:items]) + (f"; and {len(parts) - items} more" if len(parts) > items else "") + "]"
    return f"{head}: {first}.{tail}"


def _brief(self, level: str | None = "warning", limit: int = 12, rule: str | None = None) -> dict:
    """The review in as few words as it takes: {"errors", "warnings", "notes", "findings": [one line each]}.  The full
    text of one finding, with the call that fixes it, is board.review(rule="vias.slot")."""
    rv = self.review(level=level, rule=rule, limit=limit)
    return {"errors": rv["errors"], "warnings": rv["warnings"], "notes": rv["notes"], "findings": [_short(f) for f in rv["findings"]]}


def _design(self, outline=None, fab: str = "jlcpcb", layers: int | None = None, edge: str = "top", edges: dict | None = None, near: dict | None = None,
            groups: dict | None = None, fixed: dict | None = None, rotations: dict | None = None, swap: dict | None = None, fit: bool | None = None,
            order: list | None = None, widths: dict | None = None, kinds: dict | None = None, time_s: float | None = None, max_vias: int = 2,
            stitch: float | None = 10.0, name: str | bool | None = None, rev: str | None = None, silk: bool = True, place: bool = True, route: bool = True,
            accept: list | None = None) -> dict:
    """Lay the whole board out in one call and say how it came out.

    outline: (x0, y0, x1, y1), the largest the board may be (fit=True, the default when an outline is given, pulls it in
    round the parts); leave it out to keep the outline the board has.  edges: {ref: "left"|"right"|"top"|"bottom"} for
    the connectors; near, groups, fixed, rotations go to autoplace on top of what the plan works out; swap: {"U1":
    [nets]} lets those nets trade pins on that chip so they leave side by side (board.swap_pins).  order, widths and
    kinds add to the plan's routing order, widths and net kinds.  place=False keeps the placement, route=False stops
    before routing.  A step that cannot run is listed under "skipped" with the reason and the rest still runs.

    Returns {"size_mm", "layers", "placed", "routed": {"routed", "connections", "vias", "length_mm", "left"},
    "added": {ground vias, fences, thermal vias, stitching}, "drc": {"errors", "by_kind"}, "review": {"errors",
    "warnings", "findings": [one line each]}, "notes": [what the plan could not do], "skipped": {step: why}}.
    Fix what "review" and "left" name and call the single step again; do not run design() twice on one board.

    The result is judged before anyone sees it.  "refused" lists what makes the layout unacceptable: a part off the
    board or on another part, a pin-serving part or crystal away from its pin, a via on a crystal or CC net, a matching
    network away from the radio pin, an open connection, a DRC error, a review error.  While it is not empty the script
    fails at its end and every edit is taken back (a dry run reports it instead), so work in a dry run until "refused"
    is gone.  accept=["rf.feed"] waives the named rules, only for a fault the person has agreed to live with."""
    out: dict = {"skipped": {}}

    def step(what, fn):
        try:
            return fn()
        except HarnessError as e:
            out["skipped"][what] = str(e).split("\n")[0][:200]
            return None

    step("sync", self.sync)
    if outline:
        self.outline(*outline, radius=0 if place else 1.0)      # square while the placement may still pull it in; rounded after
    plan = step("plan", lambda: self.plan(edge=edge)) or {"place": {"near": {}, "edges": {}}, "route": {}, "notes": []}
    out["notes"] = [n.split(". ")[0] for n in plan.get("notes", [])][:6]
    rec = dict((plan.get("stackup") or {}).get("recommended") or {})
    if layers:
        rec["layers"] = layers
    want = int(rec.get("layers") or len(self.info().get("copper_layers") or []) or 2)
    if want > len(self.info().get("copper_layers") or []):
        step("layers", lambda: self.layers(want, planes=list(INNER_GROUND) if want >= 4 else None))
    step("stackup", lambda: self.stackup(fab=fab, **rec))
    if place:
        # a board laid out before is laid out again from its parts: its old copper comes up first, so a second run of
        # the script needs no board.clear() (what comes out the same is left alone when the plan is drawn)
        def take_up():
            n = self.unroute(keep=())
            for z in self._call("get_items", kinds=["zone"]).get("items", []):      # the pours and keep-outs are drawn again for the new placement
                self._edit({"op": "remove", "id": z["id"]}); n += 1
            self.flush()
            return n
        step("take up", take_up)
        kw = {"groups": groups, "near": {**plan["place"].get("near", {}), **(near or {})}, "edges": {**plan["place"].get("edges", {}), **(edges or {})},
              "fixed": fixed, "rotations": rotations, "fit": bool(outline) if fit is None else fit}
        if outline:
            kw["outline"] = tuple(outline)
        placed = step("place", lambda: self.autoplace(**kw))
        if placed:
            sc = placed.get("score") or {}
            out["placed"] = {"parts": placed.get("placed"), "clashes": len(sc.get("clashes") or []), "outside": sc.get("outside", 0)}
            if isinstance(placed.get("bypass"), dict):
                out["placed"]["bypass"] = placed["bypass"]
            if isinstance(out["placed"].get("bypass"), dict):      # only the capacitors that still stand in a pin's way
                out["placed"]["bypass"] = {c: {n: v for n, v in caps.items() if v.get("blocks")} for c, caps in out["placed"]["bypass"].items()}
                out["placed"]["bypass"] = {c: v for c, v in out["placed"]["bypass"].items() if v} or None
                if not out["placed"]["bypass"]:
                    del out["placed"]["bypass"]
        for ref, nets in (swap or {}).items():
            got = step(f"swap {ref}", lambda ref=ref, nets=nets: self.swap_pins(ref, list(nets)))
            if got:
                out.setdefault("swapped", {})[ref] = len(got.get("pins") or {})
    # ground on every layer that carries it, before anything is routed: the outer layers, and both inner layers of four
    if not _has_ground(self):
        copper = self.info().get("copper_layers") or ["F.Cu", "B.Cu"]
        names = [c if isinstance(c, str) else c.get("name") for c in copper]
        for layer in names:
            if layer in ("F.Cu", "B.Cu") or layer in INNER_GROUND or len(names) > 4:
                step(f"zone {layer}", lambda layer=layer: self.zone("GND", layer=layer, connect="solid" if layer.startswith("In") else "thermal"))
    step("corners", self.round_corners)      # board corners are always rounded
    step("prepare", self.prepare)
    if route:
        step("twins", self.bridge_twins)      # a USB-C connector's D+ and D- twins, joined at the pads before anything is routed
        r = dict(plan.get("route") or {})
        r["order"] = list(dict.fromkeys(list(order or []) + list(r.get("order") or [])))
        r["widths"] = {**(r.get("widths") or {}), **(widths or {})}
        r["kinds"] = {**(r.get("kinds") or {}), **(kinds or {})}
        got = step("route", lambda: self.route(**{k: v for k, v in r.items() if k in ("order", "widths", "kinds") and v}, time_s=time_s, max_vias=max_vias))
        if got:
            out["routed"] = {k: got.get(k) for k in ("routed", "connections", "vias", "length_mm")}
            left = got.get("left") or {}
            if left:      # one more pass at only what is open, as a person goes back over the last few
                more = step("route again", lambda: self.route(nets=list(left), widths=r["widths"], kinds=r["kinds"], time_s=(time_s or 60) / 2, max_vias=max_vias))
                if more:
                    out["routed"]["vias"] = (out["routed"]["vias"] or 0) + (more.get("vias") or 0)
                    left = more.get("left") or {}
            out["routed"]["left"] = left
        fin = step("finish", lambda: self.finish(stitch=stitch))
        if fin:
            out["added"] = {k: (sum(v.values()) if isinstance(v, dict) and all(isinstance(x, (int, float)) for x in v.values()) else v) for k, v in fin.items() if v not in (None, {}, 0)}
        step("cleanup", self.cleanup)
        # what the real fill and the clean-up still leave open gets one last pass: a ground pad cut off from its pour
        # takes a via, anything else is routed again on its own
        still = step("unrouted", self.unrouted) or {}
        if still:
            if any(n.split("/")[-1].upper().endswith("GND") for n in still):
                step("ground pads", self.ground_pads)
            step("route last", lambda: self.route(nets=list(still), widths=r["widths"], kinds=r["kinds"], time_s=30, max_vias=max_vias))
            out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        if silk:
            s = step("silkscreen", lambda: self.silkscreen(name=name, rev=rev))
            if s and s.get("hidden"):
                out["silk_hidden"] = s["hidden"]
    step("thermals", self.fix_thermals)      # a relief the last tracks left with too few spokes joins its pour solidly
    info = self.info()
    out["size_mm"], out["layers"], out["vias"] = info.get("size_mm"), len(info.get("copper_layers") or []), info.get("vias")
    chk = step("drc", lambda: self.check(limit=4))
    if chk:
        out["drc"] = {"errors": chk["errors"], "by_kind": chk["by_kind"], "first": chk["first"]} if chk["errors"] else {"errors": 0}
    rv = step("review", lambda: _brief(self))
    if rv:
        out["review"] = rv
    # the gate: what nobody should be shown
    waived = {str(a).lower() for a in (accept or [])}; refused: list = []
    def refuse(rule: str, text: str) -> None:
        if rule.lower() not in waived:
            refused.append(f"{rule}: {text}")
    try:
        for a, b, ox, oy in self.clashes():
            refuse("placement.clash", f"{a} stands on {b} (courtyards overlap by {min(ox, oy)} mm). Move one of them or make the board larger.")
    except HarnessError:
        pass
    try:
        for f in self.seating()["findings"]:
            if f.startswith("error "):
                rule, _, text = f[6:].partition(": ")
                refuse(rule, text)
    except HarnessError:
        pass
    if route:
        left = (out.get("routed") or {}).get("left") or {}
        if left:      # the later steps (ground vias, stitching, pours) close ground connections the router left: count what is open now
            try:
                left = self.unrouted()
            except HarnessError:
                pass
        if left:
            refuse("routing.open", f"{sum(left.values())} connections are not routed ({', '.join(f'{n} {c}' for n, c in list(left.items())[:8])}). An open net is a crossing: move or turn the part it starts at, or give swap= more nets, then route again.")
        if (out.get("drc") or {}).get("errors"):
            kinds = {k: v for k, v in out["drc"]["by_kind"].items() if k != "unconnected_items" or not left}
            if kinds:
                refuse("drc", f"{sum(kinds.values())} DRC errors ({', '.join(f'{k} {v}' for k, v in kinds.items())}). First: {'; '.join(out['drc']['first'][:2])}")
        for f in (out.get("review") or {}).get("findings", []):
            if f.startswith("error ") and not f.startswith("error drc"):
                rule, _, text = f[6:].partition(": ")
                refuse(rule, text)
    elif "skipped" in out and out["skipped"].get("place"):
        refuse("placement", out["skipped"]["place"])
    if refused:
        out["refused"] = refused
    self.project.refused = [r for r in self.project.refused if not r.startswith("board ")] + ["board " + r for r in refused]
    if not out["skipped"]:
        del out["skipped"]
    self.project.note(f"board: design() {out.get('routed', {}).get('routed', 0)} connections routed, {out.get('vias')} vias, DRC {out.get('drc', {}).get('errors', '?')} errors, review {out.get('review', {}).get('errors', '?')} errors")
    return out


def _has_ground(self) -> bool:
    from . import physics as _physics
    try:
        return bool(_physics._has_zones(self))
    except HarnessError:
        return False


def install(Board) -> None:
    Board.design = _design
    Board.brief = _brief
