"""Workshop practice (review-craft.ts): each rule on a board that states exactly the copper it is about, and the
short review and one-call layout of craft.py.  Needs Node and the built engine; skipped when they are missing."""
import json
import os
import unittest

import kicad_harness as kh

from kicad_harness import craft
from test_physics import Boards, edge, part, track, via, zone

BOX = (0, 0, 40, 30)
GROUND = [edge(BOX), zone("GND", "F.Cu", BOX), zone("GND", "B.Cu", BOX)]


def chip(ref, at, nets, pitch=0.5, n=4):
    """A small fine-pitch part: n pads down each side, 0.25 x 0.8 mm, lying across; nets: {pad number: net}."""
    pads = []
    for i in range(n):
        y = (i - (n - 1) / 2) * pitch
        pads.append((str(i + 1), -1.5, y, 0.8, 0.25, nets.get(str(i + 1), "")))
        pads.append((str(2 * n - i), 1.5, y, 0.8, 0.25, nets.get(str(2 * n - i), "")))
    return part(ref, at, pads, value="MCU", lib="Package_DFN_QFN:QFN")


class Craft(Boards):
    def test_thin_track_in_the_open_is_reported_and_a_neck_at_the_pad_is_not(self):
        b = self.open(*GROUND, chip("U1", (10, 10), {"8": "SIG", "7": "NECK"}), part("R1", (30, 9.25), [("1", 0, 0, 0.6, 0.6, "SIG")]), part("R2", (13.5, 12, ), [("1", 0, 0, 0.6, 0.6, "NECK")]),
                      track("SIG", [(11.5, 9.25), (30, 9.25)], width=0.1), track("NECK", [(11.5, 9.75), (12.5, 9.75), (13.5, 10.75), (13.5, 12)], width=0.1))
        got = self.finding(b.review(), "tracks.minimum")
        self.assertIn("SIG", got)
        self.assertNotIn("NECK", got)

    def test_reset_beside_a_clock_is_crosstalk_and_apart_it_is_not(self):
        def board(gap):
            return self.open(*GROUND, part("J1", (2, 10), [("1", 0, 0, 0.6, 0.6, "NRST"), ("2", 0, 2, 0.6, 0.6, "SPI_SCK")]), part("J2", (38, 10), [("1", 0, 0, 0.6, 0.6, "NRST"), ("2", 0, 2, 0.6, 0.6, "SPI_SCK")]),
                             track("NRST", [(2, 10), (38, 10)], width=0.2), track("SPI_SCK", [(2, 12), (4, 10 + gap), (36, 10 + gap), (38, 12)], width=0.2))
        self.assertIn("crosstalk.victims", self.failed(board(0.4).review()))
        self.assertNotIn("crosstalk.victims", self.failed(board(1.5).review()))

    def test_a_tight_row_of_vias_is_a_slot_and_a_spaced_row_is_not(self):
        def board(pitch):
            return self.open(*GROUND, *[via(f"D{i}", (10 + i * pitch, 15)) for i in range(8)])
        self.assertIn("vias.slot", self.failed(board(0.7).review()))
        self.assertNotIn("vias.slot", self.failed(board(1.4).review()))

    def test_supply_via_at_the_pin_with_the_capacitor_beyond_it(self):
        def board(via_at):
            return self.open(*GROUND, chip("U1", (10, 10), {"8": "+3V3", "1": "GND"}), part("C1", (14.5, 9.25), [("1", -0.5, 0, 0.5, 0.6, "+3V3"), ("2", 0.5, 0, 0.5, 0.6, "GND")], value="100n"),
                             track("+3V3", [(11.5, 9.25), (14, 9.25)], width=0.3), via("+3V3", via_at), via("GND", (15.8, 9.25)))
        self.assertIn("bypass.order", self.failed(board((12.4, 8.5)).review()))
        self.assertNotIn("bypass.order", self.failed(board((14, 8.3)).review()))

    def test_leaving_a_fine_pitch_pad_sideways(self):
        def board(pin, pts):
            return self.open(*GROUND, chip("U1", (10, 10), {pin: "SIG"}), part("R1", (20, 6), [("1", 0, 0, 0.6, 0.6, "SIG")]), track("SIG", pts, width=0.2))
        self.assertIn("U1: pin 7", self.finding(board("7", [(11.5, 9.75), (11.75, 9.5), (14, 9.5), (17.5, 6), (20, 6)]).review(), "pads.entry"))   # across pin 8
        self.assertNotIn("pads.entry", self.failed(board("7", [(11.5, 9.75), (13, 9.75), (16.75, 6), (20, 6)]).review()))                       # out through the end
        self.assertNotIn("pads.entry", self.failed(board("8", [(11.5, 9.25), (11.5, 8), (13.5, 6), (20, 6)]).review()))                         # the row's last pin turns away

    def test_supply_via_wants_a_ground_via_beside_it(self):
        b = self.open(*GROUND, part("J1", (5, 5), [("1", 0, 0, 0.6, 0.6, "+3V3")]), track("+3V3", [(5, 5), (20, 5)], width=0.5), via("+3V3", (20, 5)), via("GND", (35, 25)))
        self.assertIn("+3V3", self.finding(b.review(level=None), "power.return"))
        b = self.open(*GROUND, part("J1", (5, 5), [("1", 0, 0, 0.6, 0.6, "+3V3")]), track("+3V3", [(5, 5), (20, 5)], width=0.5), via("+3V3", (20, 5)), via("GND", (21, 5)))
        self.assertEqual("", self.finding(b.review(level=None), "power.return"))

    def test_signal_on_a_ground_plane_layer(self):
        import test_physics as tp
        old = tp.HEAD2
        tp.HEAD2 = old.replace('(2 "B.Cu" signal)', '(4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)')
        self.addCleanup(setattr, tp, "HEAD2", old)
        b = self.open(*GROUND, zone("GND", "In1.Cu", BOX), part("J1", (5, 5), [("1", 0, 0, 0.6, 0.6, "SIG")]), track("SIG", [(5, 5), (25, 5)], layer="In1.Cu"), track("SIG", [(5, 5), (5, 20)], layer="In2.Cu"))
        got = self.finding(b.review(), "planes.signals")
        self.assertIn("In1.Cu: 20 mm", got)
        self.assertNotIn("In2.Cu", got)

    def test_bus_lines_with_unequal_vias(self):
        def board(extra):
            items = [part("U1", (5, 10), [(str(i + 1), 0, i * 2, 0.6, 0.6, f"QSPI_SD{i}") for i in range(4)]), part("U2", (30, 10), [(str(i + 1), 0, i * 2, 0.6, 0.6, f"QSPI_SD{i}") for i in range(4)])]
            for i in range(4):
                y = 10 + i * 2
                if i == 2 and extra:
                    items += [track(f"QSPI_SD{i}", [(5, y), (12, y)]), via(f"QSPI_SD{i}", (12, y)), track(f"QSPI_SD{i}", [(12, y), (22, y)], layer="B.Cu"), via(f"QSPI_SD{i}", (22, y)), track(f"QSPI_SD{i}", [(22, y), (30, y)])]
                else:
                    items.append(track(f"QSPI_SD{i}", [(5, y), (30, y)]))
            return self.open(*GROUND, *items)
        self.assertIn("QSPI_SD2 2", self.finding(board(True).review(), "bus.transitions"))
        self.assertNotIn("bus.transitions", self.failed(board(False).review()))

    def test_via_too_deep_for_its_drill(self):
        thin = '(via (at 20 15) (size 0.3) (drill 0.1) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "v-thin"))'
        b = self.open(*GROUND, part("J1", (5, 15), [("1", 0, 0, 0.6, 0.6, "SIG")]), track("SIG", [(5, 15), (20, 15)]), thin, via("SIG", (10, 15)))
        got = self.finding(b.review(), "vias.aspect")
        self.assertIn("1 via with a 0.1 mm drill", got)
        self.assertNotIn("0.3 mm drill", got)

    def test_short_finding(self):
        row = "warning vias.slot: These vias stand close. Leave 0.55 mm between them. [8 vias from (1, 2) to (3, 4): a 5 mm slot; b; c]"
        self.assertEqual(craft._short(row, items=2), "warning vias.slot: These vias stand close. [8 vias from (1, 2) to (3, 4): a 5 mm slot; b; and 1 more]")
        self.assertEqual(craft._short("note drc: Nothing here."), "note drc: Nothing here.")

    def test_brief_is_one_line_each(self):
        b = self.open(*GROUND, *[via(f"D{i}", (10 + i * 0.7, 15)) for i in range(8)])
        got = b.brief()
        self.assertTrue(any(f.startswith("warning vias.slot: ") and f.count(". ") <= 1 for f in got["findings"]), got)
        self.assertNotIn("passed", got)


class ChipFrame(unittest.TestCase):
    """escape_chips' frame of a fine-pitch chip: its four pin rows and pitch, whatever its rotation (no engine needed)."""

    @staticmethod
    def qfn(rotation, pitch=0.4, per_side=14, twice=False):
        import math
        pads, n = [], 0
        a = math.radians(-rotation)
        for side in range(4):
            nx, ny = math.cos(a + side * math.pi / 2), math.sin(a + side * math.pi / 2)
            for i in range(per_side):
                s = (i - (per_side - 1) / 2) * pitch
                n += 1
                pad = [str(n), round(nx * 3.5 - ny * s, 4), round(ny * 3.5 + nx * s, 4), f"N{n}", 0.25, 0.9]
                pads.append(pad)
                if twice and i == 0:
                    pads.append(list(pad))      # a pad drawn twice on one spot, as some footprints have
        pads.append(["57", 0.0, 0.0, "GND", 4.0, 4.0])      # the exposed pad
        return {"ref": "U1", "x": 0.0, "y": 0.0, "rotation": rotation, "pads": pads}

    def test_rows_and_pitch_of_a_turned_chip(self):
        for rot in (0, -45, 90, -135):
            c, normals, rows, pitch = craft._chip_frame(self.qfn(rot, twice=True))
            self.assertEqual(len(rows), 4)
            self.assertEqual(sorted(len({q[0] for q in r}) for r in rows.values()), [14, 14, 14, 14])
            self.assertAlmostEqual(pitch, 0.4, places=3)
            self.assertFalse(any(q[0] == "57" for r in rows.values() for q in r))

    def test_coarse_or_small_parts_are_not_chips(self):
        self.assertIsNone(craft._chip_frame(self.qfn(0, pitch=1.0)))
        self.assertIsNone(craft._chip_frame(self.qfn(0, per_side=4)))

    def test_crystal_and_antenna_nets_are_never_fanned(self):
        for net in ("/HXIN", "/LXOUT", "/RF", "Net-(AE1-ANT)", "/XTAL_IN"):
            self.assertTrue(craft._NO_FAN.search(net), net)
        for net in ("/GPIO9", "/SWDIO", "/ICM_MOSI", "/RESET"):
            self.assertFalse(craft._NO_FAN.search(net), net)

    def test_unbox_and_escapes_leave_ground_supplies_and_pairs_alone(self):
        for net in ("GND", "+3.3V", "/USB_DP", "/DN", "/HXIN", ""):
            self.assertTrue(craft._kept_net(net), net)
        for net in ("/GPIO9", "/SWCLK", "/SPI_MOSI"):
            self.assertFalse(craft._kept_net(net), net)


class RoutingPlan(Boards):
    """The routing AI's own plan for a crowded chip: board.channels() reads the problem, board.escape() lays the escapes
    it chose, and board.route(plan={"paths", "order", "escapes"}) routes inside its corridors."""

    def board(self):
        # a 0.5 mm pitch chip with 10 pads down each side, every pad on the west side wired to a header pad far west
        nets = {str(i + 1): f"S{i + 1}" for i in range(10)}
        far = [part(f"J{i + 1}", (2, 4 + i * 2.2), [("1", 0, 0, 1.0, 1.0, f"S{i + 1}")]) for i in range(10)]
        return self.open(edge(BOX), chip("U1", (20, 15), nets, pitch=0.5, n=10), *far)

    def test_channels_name_the_pins_the_free_tracks_and_the_open_connections(self):
        b = self.board()
        got = b.channels("U1", depths=[0.5, 2])
        self.assertIn("W", got["sides"], got)
        w = got["sides"]["W"]
        self.assertIn("1 S1*", w["pins"])
        self.assertEqual(sorted(w["free_tracks"]), ["B.Cu", "F.Cu"])
        self.assertTrue(w["free_tracks"]["B.Cu"].startswith("0.5mm "), w)
        self.assertEqual(len(got["open"]), 10)
        self.assertTrue(all(" plan " in o for o in got["open"]), got["open"][:2])
        self.assertEqual(b.info()["unrouted_connections"], 10, "nothing was laid")

    def test_escapes_and_paths_are_laid_as_written(self):
        b = self.board()
        esc = b.escape({"U1.3": "via 0.6", "U1.6": "out 0.5", "U1.9": "via 1.0 N"})
        self.assertEqual(esc["laid"], 3, esc)
        self.assertEqual(b.info().get("vias"), 2)
        # S1's path: west on F.Cu along its own row, then the router lays it inside that corridor
        res = b.route(nets=["S1", "S2"], fill=False, time_s=20, plan={"paths": {"S1": [[17.0, 12.75, "F.Cu"], [4.0, 12.75, "F.Cu"]]}, "order": ["S2"]})
        self.assertEqual(res["plan"]["given"], 1, res.get("plan"))
        self.assertEqual(res["left_of_asked"], {}, res)

    def test_an_escape_blocked_out_where_asked_takes_a_nearer_spot_and_the_small_via(self):
        # U1.3's way west is shut 0.7 mm past its pad by a wall of another net; the via asked 0.6 mm out comes in to
        # the pad, and the net class's 0.8 mm via does not fit there while the rules' smallest (0.4 / 0.2 mm) does
        nets = {"3": "S3"}
        b = self.open(edge(BOX), chip("U1", (20, 15), nets, pitch=0.5, n=10), part("J1", (2, 4), [("1", 0, 0, 1.0, 1.0, "S3")]),
                      track("W", [(17.2, 10), (17.2, 20)], width=0.2), part("R9", (2, 20), [("1", 0, 0, 1.0, 1.0, "W")]))
        self.project.close()      # Board Setup's constraints: vias down to 0.4 / 0.2 mm (0.1 mm ring); the class's via is 0.8 / 0.4
        with open(os.path.join(self.dir, "p.kicad_pro"), "w", encoding="utf-8") as f:
            json.dump({"meta": {"filename": "p.kicad_pro", "version": 3}, "net_settings": {"classes": [{"name": "Default", "clearance": 0.2, "track_width": 0.2, "via_diameter": 0.8, "via_drill": 0.4}], "meta": {"version": 4}},
                       "board": {"design_settings": {"rules": {"min_via_diameter": 0.4, "min_through_hole_diameter": 0.2, "min_via_annular_width": 0.1}}}}, f)
        self.project = kh.open(self.dir)
        b = self.project.board()
        rules = b.rules()
        if float(rules.get("min_via_diameter") or 0) > 0.4 or float(rules.get("min_via_drill") or 0) > 0.2:
            self.skipTest(f"the board's rules allow no 0.4 / 0.2 mm via: {rules}")
        esc = b.escape({"U1.3": "via 0.6"})
        self.assertEqual(esc["laid"], 1, esc)
        self.assertEqual(esc.get("small"), ["U1.3"], esc)
        v = [it for it in b._all_items(["via"])]
        self.assertEqual(len(v), 1)
        self.assertIn("(size 0.4)", v[0]["sexpr"])
        at = [float(x) for x in v[0]["sexpr"].split("(at ")[1].split(")")[0].split()]
        self.assertLess(18.1 - at[0], 0.45, at)      # nearer the pad end (x = 18.1) than the 0.6 mm asked

    def test_mend_joins_two_loose_ends_of_a_net_on_different_layers_with_a_via(self):
        # S runs from J1 on F.Cu and from J2 down a via on B.Cu; the via that joined the two ends was taken up, so an
        # F.Cu end and a B.Cu end lie 0.2 mm apart and the connection is open
        b = self.open(edge(BOX), part("J1", (5, 10), [("1", 0, 0, 1.0, 1.0, "S")]), part("J2", (20, 10), [("1", 0, 0, 1.0, 1.0, "S")]),
                      track("S", [(5, 10), (10, 10)], width=0.2), track("S", [(20, 10), (14, 10)], width=0.2),
                      via("S", (14, 10)), track("S", [(14, 10), (10.2, 10)], layer="B.Cu", width=0.2))
        self.assertEqual(b.info()["unrouted_connections"], 1)
        got = b.mend()
        self.assertEqual(len(got["joined"]), 1, got)
        self.assertEqual(b.info().get("vias"), 2)
        self.assertEqual(b.info()["unrouted_connections"], 0)
        self.assertEqual(b.mend(nets=["S"]), {"joined": [], "left": []}, "nothing left to join")

    def test_unbox_leaves_a_board_without_a_fine_pitch_chip_as_it_was(self):
        b = self.board()        # ten pins a side: not a chip unbox works on
        got = b.unbox(budget_s=30)
        self.assertEqual((got["before"], got["after"], got["tried"]), (10, 10, []), got)
        self.assertEqual(b.info()["unrouted_connections"], 10)


class Untangle(Boards):
    """board.untangle(): an open end is laid again locally, only the nets taken up near it are routed again."""

    def test_pair_partners(self):
        nets = {"/DP", "/DN", "/USB_D+", "/USB_D-", "/LVDS_P", "/LVDS_N", "/GPIO9"}
        self.assertEqual(craft._partner("/DP", nets), "/DN")
        self.assertEqual(craft._partner("/USB_D-", nets), "/USB_D+")
        self.assertEqual(craft._partner("/LVDS_P", nets), "/LVDS_N")
        self.assertIsNone(craft._partner("/GPIO9", nets))

    def test_an_open_end_is_closed_locally_and_far_copper_stays(self):
        b = self.open(edge(BOX), part("R1", (5, 15), [("1", 0, 0, 1.0, 1.0, "S")]), part("R2", (15, 15), [("1", 0, 0, 1.0, 1.0, "S")]),
                      part("R3", (30, 2), [("1", 0, 0, 1.0, 1.0, "W")]), part("R4", (30, 28), [("1", 0, 0, 1.0, 1.0, "W")]),
                      track("W", [(30, 2), (30, 28)]))
        far = {it["id"] for it in b._all_items(["segment"])}
        got = b.untangle(budget_s=120, time_s=5, nets=["S"])
        self.assertEqual((got["before"], got["after"]), (1, 0), got)
        self.assertEqual(len(got["kept"]), 1, got["tried"])
        self.assertTrue(far <= {it["id"] for it in b._all_items(["segment"])}, "copper far from the open end is never taken up")

    def test_nothing_open_nothing_tried(self):
        b = self.open(edge(BOX), part("R1", (5, 15), [("1", 0, 0, 1.0, 1.0, "S")]), part("R2", (15, 15), [("1", 0, 0, 1.0, 1.0, "S")]),
                      track("S", [(5, 15), (15, 15)]))
        got = b.untangle(budget_s=30)
        self.assertEqual((got["before"], got["after"], got["tried"]), (0, 0, []), got)



class FanOut(Boards):
    """board.fan_plan() writes a fine-pitch chip's fan-out as one route plan (the routing AI's pattern: a via per pin in
    two staggered rows, a corridor from each via straight for where the net goes, under the chip when that is behind
    it); board.refan() takes up the chip's band and lays it again from that plan, keep-best."""

    def chip_board(self, *extra, east_far=True):
        # a 0.5 mm pitch chip, ten pads down its west and east sides 6 mm apart: the west pins go to headers far west; the east pins too (behind the
        # chip for them) or to headers far east; U1.11 is ground and U1.20 goes to a pad just east of it
        nets = {str(i + 1): f"S{i + 1}" for i in range(10)}
        nets.update({str(i): f"E{i}" for i in range(12, 20)})
        nets.update({"11": "GND", "20": "N20"})
        parts = [part(f"J{i + 1}", (2, 4 + i * 2.2), [("1", 0, 0, 1.0, 1.0, f"S{i + 1}")]) for i in range(10)]
        parts += [part(f"K{i}", (4 if east_far else 38, 3 + (i - 12) * 3), [("1", 0, 0, 1.0, 1.0, f"E{i}")]) for i in range(12, 20)]
        parts += [part("R20", (24, 13.5), [("1", 0, 0, 0.6, 0.6, "N20")]), part("G1", (30, 28), [("1", 0, 0, 1.0, 1.0, "GND")])]
        pads = [(str(i + 1), -3.0, (i - 4.5) * 0.5, 0.8, 0.25, nets.get(str(i + 1), "")) for i in range(10)]
        pads += [(str(20 - i), 3.0, (i - 4.5) * 0.5, 0.8, 0.25, nets.get(str(20 - i), "")) for i in range(10)]
        return self.open(edge(BOX), part("U1", (20, 15), pads, value="MCU", lib="Package_DFN_QFN:QFN"), *parts, *extra)

    def test_a_via_per_pin_staggered_and_a_corridor_for_where_the_net_goes(self):
        b = self.chip_board()
        fp = b.fan_plan("U1")
        esc, paths = fp["escapes"], fp["paths"]
        self.assertNotIn("U1.11", esc, "ground is never escaped")
        self.assertNotIn("U1.20", esc, "a pin whose pad is just in front keeps the chip's layer")
        self.assertEqual(len(esc), 18, esc)
        west = [esc[f"U1.{i}"] for i in range(1, 11)]
        self.assertTrue(all(w["via"] and w["thin"] for w in west), west)
        xs = [round(w["to"][-1][0], 3) for w in west]      # as buses: a staircase 0.4 mm a step from 0.5 mm past the pad ends (x = 16.6)
        self.assertEqual(max(xs), 16.1, xs)
        self.assertTrue(all(abs(a - c) >= 0.38 for a, c in zip(xs, xs[1:])), xs)
        rows = [round(w["to"][-1][0], 3) for w in (b.fan_plan("U1", bus=False)["escapes"][f"U1.{i}"] for i in range(1, 11))]
        self.assertEqual(sorted(set(rows)), [15.5, 16.1], rows)      # two staggered rows, 0.5 and 1.1 mm out
        self.assertTrue(all(a != c for a, c in zip(rows, rows[1:])), "neighbours staggered")
        ys = [w["to"][-1][1] for w in west]
        self.assertTrue(all(abs(b_ - a - 0.5) < 1e-3 for a, b_ in zip(ys, ys[1:])), "on the row's pitch line")
        self.assertTrue(all(isinstance(f[-1], str) for f in fp["fallback"].values()))
        for i in range(12, 20):      # behind the chip: from the via east of the chip under it to the west, on B.Cu
            self.assertIn("behind the chip", fp["pins"][f"U1.{i}"])
            (vx, _, lv), (ex, _, le) = paths[f"E{i}"][0], paths[f"E{i}"][-1]
            self.assertIn("under it to the corner", fp["pins"][f"U1.{i}"])
            self.assertGreater(vx, 23.4)
            self.assertLess(ex, 18.0)      # across the chip (its west pads end at 17.4)
            self.assertEqual((lv, le), ("B.Cu", "B.Cu"))
        self.assertTrue(fp["order"][0].startswith("E"), "the pins behind the chip are laid first")
        self.assertEqual(b.info()["vias"] or 0, 0, "nothing is laid")
        self.assertEqual(b.fan_plan("U1", nets=["S3"])["order"], ["S3"])

    def test_refan_lays_the_band_again_and_keeps_it_only_when_it_helps(self):
        # W passes through the chip's band (x = 15.5): refan takes it up with the chip's escapes, routes the chip's open
        # nets from the planned fan-out and W again; F, far away, stays where it is
        extra = [part("R1", (15.5, 3), [("1", 0, 0, 0.8, 0.8, "W")]), part("R2", (15.5, 27), [("1", 0, 0, 0.8, 0.8, "W")]), track("W", [(15.5, 3), (15.5, 27)], width=0.2),
                 part("R3", (36, 3), [("1", 0, 0, 0.8, 0.8, "F")]), part("R4", (36, 27), [("1", 0, 0, 0.8, 0.8, "F")]), track("F", [(36, 3), (36, 27)], width=0.2)]
        b = self.chip_board(*extra, east_far=False)
        far = {it["id"] for it in b._all_items(["segment"]) if '"F"' in it["sexpr"]}
        before = b.info()["unrouted_connections"]
        got = b.refan("U1", time_s=20, tries=[(2.0, False)])
        self.assertEqual(got["before"], before)
        self.assertLess(got["after"], before, got["tried"])
        self.assertEqual(len(got["kept"]), 1, got)
        self.assertNotIn("W", b.unrouted(), "what the take-up moved is laid again")
        self.assertTrue(far <= {it["id"] for it in b._all_items(["segment"])}, "copper outside the band stays")
        self.assertTrue(any("via" in v for v in got["plan"].values()), got["plan"])

    def test_refan_refuses_a_part_that_is_not_a_fine_pitch_chip(self):
        b = self.open(edge(BOX), part("R1", (5, 15), [("1", 0, 0, 1.0, 1.0, "S")]))
        with self.assertRaises(kh.HarnessError):
            b.refan("R1")
        with self.assertRaises(kh.HarnessError):
            b.fan_plan("R1")

    def test_check_moves_a_via_off_a_taken_spot_and_keeps_its_neighbours_apart(self):
        # a ground via sits where U1.3's via would go 0.5 mm past its pad (x = 16.1 on its lane, y = 15 - 1.25)
        b = self.chip_board(via("GND", (16.1, 13.75)))
        fp = b.fan_plan("U1", check=True, bus=False)
        xs = {i: round(fp["escapes"][f"U1.{i}"]["to"][-1][0], 3) for i in range(1, 11)}
        self.assertNotAlmostEqual(xs[3], 16.1, places=2)
        self.assertTrue(all(abs(xs[i] - xs[i + 1]) >= 0.38 for i in range(1, 10)), xs)

    def test_an_escape_no_route_used_comes_up_with_its_stub(self):
        b = self.chip_board()
        b.escape({"U1.3": {"to": [[16.6, 13.75], [16.1, 13.75]], "via": True}})
        self.assertEqual(b.info().get("vias"), 1)
        gone = craft._drop_unused_escapes(b)
        self.assertGreaterEqual(gone, 2, "the via and its stub")
        self.assertEqual(b.info().get("vias") or 0, 0)
        self.assertEqual([it for it in b._all_items(["segment"])], [])


class WrittenPaths(Boards):
    """board.cross(): connections laid along the AI's written paths (strict: inside the corridor or not at all), the
    copper in their way taken up and laid again, keep-best; board.move_pair() and its rules for a pair laid again."""

    def wall_board(self):
        # S from R1 to R2 straight across; W, a wall of another net, crosses its way on F.Cu
        return self.open(edge(BOX), part("R1", (5, 15), [("1", 0, 0, 1.0, 1.0, "S")]), part("R2", (35, 15), [("1", 0, 0, 1.0, 1.0, "S")]),
                         part("R3", (20, 3), [("1", 0, 0, 1.0, 1.0, "W")]), part("R4", (20, 27), [("1", 0, 0, 1.0, 1.0, "W")]),
                         track("W", [(20, 3), (20, 27)], width=0.25))

    def test_a_strict_path_is_laid_inside_its_corridor_or_not_at_all(self):
        b = self.wall_board()
        b.route(nets=["S"], fill=False, time_s=10, plan={"paths": {"S": [[5, 15, "F.Cu"], [35, 15, "F.Cu"]]}, "strict": True})
        self.assertIn("S", b.unrouted(), "the wall shuts the corridor on F.Cu and a strict path does not go round it on B.Cu")
        loose = b.route(nets=["S"], fill=False, time_s=10, plan={"paths": {"S": [[5, 15, "F.Cu"], [35, 15, "F.Cu"]]}})
        self.assertEqual(loose["left_of_asked"], {}, "without strict the router leaves the corridor")
        self.assertIn("S", (loose.get("plan") or {}).get("given_outside") or [], loose.get("plan"))

    def test_cross_takes_up_what_is_in_the_way_lays_the_path_and_the_rest_again(self):
        b = self.wall_board()
        got = b.cross({"S": [[5, 15, "F.Cu"], [35, 15, "F.Cu"]]}, time_s=10)
        self.assertTrue(got["kept"], got)
        self.assertEqual((got["before"], got["after"]), (1, 0), got)
        self.assertEqual(got["laid"], {"S": "inside"}, got)
        self.assertEqual(got["moved"], ["W"])
        self.assertEqual(b.unrouted(), {})
        s = [it for it in b._all_items(["segment"]) if '"S"' in it["sexpr"]]
        self.assertTrue(s and all('"F.Cu"' in it["sexpr"] for it in s), "S stays on its written layer")

    def test_cross_that_does_not_help_is_taken_back(self):
        b = self.wall_board()
        ids = {it["id"] for it in b._all_items(["segment"])}
        got = b.cross({"S": [[5, 15, "F.Cu"], [35, 15, "F.Cu"]]}, claim=False, time_s=10)
        self.assertFalse(got["kept"], got)
        self.assertEqual(got["laid"], {"S": "open"}, got)
        self.assertEqual({it["id"] for it in b._all_items(["segment"])}, ids, "everything back as it was")

    def test_a_pair_laid_again_keeps_the_rules(self):
        def st(vp, vn, mp, mn):
            return {"/DP": {"vias": vp, "mm": mp}, "/DN": {"vias": vn, "mm": mn}}
        before = st(1, 1, 30.0, 30.2)
        self.assertEqual(craft._pair_ok(before, st(0, 0, 28.0, 28.1), set()), "")
        self.assertEqual(craft._pair_ok(before, st(1, 1, 31.0, 31.3), set()), "")
        self.assertIn("vias", craft._pair_ok(before, st(1, 0, 31.0, 31.0), set()))
        self.assertIn("more vias", craft._pair_ok(before, st(2, 2, 31.0, 31.0), set()))
        self.assertIn("skew", craft._pair_ok(before, st(1, 1, 31.0, 32.5), set()))
        self.assertIn("open", craft._pair_ok(before, st(0, 0, 28.0, 28.0), {"/DN"}))
        self.assertEqual(craft._pair_ok(st(2, 0, 30.0, 30.0), st(2, 0, 30.0, 30.2), set()), "", "unequal only as it was before")

    def test_move_pair_needs_a_pair_near_the_pin(self):
        b = self.wall_board()
        with self.assertRaises(kh.HarnessError):
            b.move_pair("R1.1")
