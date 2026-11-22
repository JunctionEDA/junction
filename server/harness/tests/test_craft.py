"""Workshop practice (review-craft.ts): each rule on a board that states exactly the copper it is about, and the
short review and one-call layout of craft.py.  Needs Node and the built engine; skipped when they are missing."""
import unittest

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

    def test_unbox_leaves_a_board_without_a_fine_pitch_chip_as_it_was(self):
        b = self.board()        # ten pins a side: not a chip unbox works on
        got = b.unbox(budget_s=30)
        self.assertEqual((got["before"], got["after"], got["tried"]), (10, 10, []), got)
        self.assertEqual(b.info()["unrouted_connections"], 10)

