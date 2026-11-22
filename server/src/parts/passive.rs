//! Vendor passives redrawn as KiCad's own `Device` symbols.
//!
//! EasyEDA draws resistors, capacitors, inductors, diodes and the like each in its
//! own style (a capacitor with long leads, a resistor as a zig-zag, …).  When a
//! part plainly is one two-pin passive, the drawing is replaced by KiCad's
//! `Device:R`, `C`, `C_Polarized`, `L`, `FerriteBead`, `D`, `D_Schottky`,
//! `D_Zener`, `LED` or `Crystal` (graphics, pin placement and field positions
//! copied from the KiCad symbol library, CC-BY-SA 4.0 with the library exception),
//! and the vendor's pin numbers go on its pins, so the footprint still matches.
//!
//! A part with a polarity (diodes, LEDs, polarized capacitors) is only redrawn
//! when it is certain which pin is which: from the pin names (K/A, +/-) or, for a
//! diode, from the arrowhead the vendor drew (it points at the cathode).
//! Anything uncertain keeps the vendor's drawing.

use super::easyeda::{fnum, q};
use super::tidy::RawPin;

type Tri = [[f64; 2]; 3];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Resistor,
    Capacitor,
    CapacitorPolarized,
    Inductor,
    FerriteBead,
    Diode,
    Schottky,
    Zener,
    Led,
    Crystal,
}

/// One KiCad `Device` symbol: its graphics (unit 0) and how its two pins and fields sit.
struct Device {
    art: &'static [&'static str],
    /// pin 1 and pin 2: (x, y, angle), and the pin length
    pins: [(f64, f64, i32); 2],
    length: f64,
    /// KiCad's pin names ("K", "A"), or none
    names: [&'static str; 2],
    /// `(at …)` and justification of Reference and Value
    reference: (&'static str, &'static str),
    value: (&'static str, &'static str),
    /// `(pin_names …)` as the library writes it
    pin_names: &'static str,
    bbox: [f64; 4],
}

impl Kind {
    fn device(self) -> Device {
        let vertical = [(0.0, 3.81, 270), (0.0, -3.81, 90)];
        let horizontal = [(-3.81, 0.0, 0), (3.81, 0.0, 180)];
        let diode_fields = (("0 2.54 0", ""), ("0 -2.54 0", ""));
        match self {
            Kind::Resistor => Device {
                art: &[r#"(rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))"#],
                pins: vertical,
                length: 1.27,
                names: ["", ""],
                reference: ("2.032 0 90", ""),
                value: ("0 0 90", ""),
                pin_names: "(pin_names (offset 0))",
                bbox: [-1.016, -3.81, 2.032, 3.81],
            },
            Kind::Capacitor => Device {
                art: &[
                    r#"(polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none)))"#,
                ],
                pins: vertical,
                length: 2.794,
                names: ["", ""],
                reference: ("0.635 2.54 0", "(justify left)"),
                value: ("0.635 -2.54 0", "(justify left)"),
                pin_names: "(pin_names (offset 0.254))",
                bbox: [-2.032, -3.81, 2.032, 3.81],
            },
            Kind::CapacitorPolarized => Device {
                art: &[
                    r#"(rectangle (start -2.286 0.508) (end 2.286 1.016) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -1.778 2.286) (xy -0.762 2.286)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -1.27 2.794) (xy -1.27 1.778)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(rectangle (start 2.286 -0.508) (end -2.286 -1.016) (stroke (width 0) (type default)) (fill (type outline)))"#,
                ],
                pins: vertical,
                length: 2.794,
                names: ["", ""],
                reference: ("0.635 2.54 0", "(justify left)"),
                value: ("0.635 -2.54 0", "(justify left)"),
                pin_names: "(pin_names (offset 0.254))",
                bbox: [-2.286, -3.81, 2.286, 3.81],
            },
            Kind::Inductor => Device {
                art: &[
                    r#"(arc (start 0 -2.54) (mid 0.6323 -1.905) (end 0 -1.27) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(arc (start 0 -1.27) (mid 0.6323 -0.635) (end 0 0) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(arc (start 0 0) (mid 0.6323 0.635) (end 0 1.27) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(arc (start 0 1.27) (mid 0.6323 1.905) (end 0 2.54) (stroke (width 0) (type default)) (fill (type none)))"#,
                ],
                pins: vertical,
                length: 1.27,
                names: ["1", "2"],
                reference: ("-1.27 0 90", ""),
                value: ("1.905 0 90", ""),
                pin_names: "(pin_names (offset 1.016) (hide yes))",
                bbox: [-1.27, -3.81, 1.905, 3.81],
            },
            Kind::FerriteBead => Device {
                art: &[
                    r#"(polyline (pts (xy 0 -1.27) (xy 0 -1.2192)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 0 1.27) (xy 0 1.2954)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -2.7686 0.4064) (xy -1.7018 2.2606) (xy 2.7686 -0.3048) (xy 1.6764 -2.159) (xy -2.7686 0.4064)) (stroke (width 0) (type default)) (fill (type none)))"#,
                ],
                pins: vertical,
                length: 2.54,
                names: ["", ""],
                reference: ("-3.81 0.635 90", ""),
                value: ("3.81 0 90", ""),
                pin_names: "(pin_names (offset 0))",
                bbox: [-3.81, -3.81, 3.81, 3.81],
            },
            Kind::Diode => Device {
                art: &[
                    r#"(polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 1.27 0) (xy -1.27 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 0) (xy 1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                ],
                pins: horizontal,
                length: 2.54,
                names: ["K", "A"],
                reference: diode_fields.0,
                value: diode_fields.1,
                pin_names: "(pin_names (offset 1.016) (hide yes))",
                bbox: [-3.81, -2.54, 3.81, 2.54],
            },
            Kind::Schottky => Device {
                art: &[
                    r#"(polyline (pts (xy 1.27 0) (xy -1.27 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 0) (xy 1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -1.905 0.635) (xy -1.905 1.27) (xy -1.27 1.27) (xy -1.27 -1.27) (xy -0.635 -1.27) (xy -0.635 -0.635)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                ],
                pins: horizontal,
                length: 2.54,
                names: ["K", "A"],
                reference: diode_fields.0,
                value: diode_fields.1,
                pin_names: "(pin_names (offset 1.016) (hide yes))",
                bbox: [-3.81, -2.54, 3.81, 2.54],
            },
            Kind::Zener => Device {
                art: &[
                    r#"(polyline (pts (xy 1.27 0) (xy -1.27 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -1.27 -1.27) (xy -1.27 1.27) (xy -0.762 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 1.27 -1.27) (xy 1.27 1.27) (xy -1.27 0) (xy 1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                ],
                pins: horizontal,
                length: 2.54,
                names: ["K", "A"],
                reference: diode_fields.0,
                value: diode_fields.1,
                pin_names: "(pin_names (offset 1.016) (hide yes))",
                bbox: [-3.81, -2.54, 3.81, 2.54],
            },
            Kind::Led => Device {
                art: &[
                    r#"(polyline (pts (xy -1.27 -1.27) (xy -1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -1.27 0) (xy 1.27 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 1.27 -1.27) (xy 1.27 1.27) (xy -1.27 0) (xy 1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -3.048 -0.762) (xy -4.572 -2.286) (xy -3.81 -2.286) (xy -4.572 -2.286) (xy -4.572 -1.524)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -1.778 -0.762) (xy -3.302 -2.286) (xy -2.54 -2.286) (xy -3.302 -2.286) (xy -3.302 -1.524)) (stroke (width 0) (type default)) (fill (type none)))"#,
                ],
                pins: horizontal,
                length: 2.54,
                names: ["K", "A"],
                reference: diode_fields.0,
                value: diode_fields.1,
                pin_names: "(pin_names (offset 1.016) (hide yes))",
                bbox: [-4.572, -2.54, 3.81, 2.54],
            },
            Kind::Crystal => Device {
                art: &[
                    r#"(rectangle (start -1.143 2.54) (end 1.143 -2.54) (stroke (width 0.3048) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -2.54 0) (xy -1.905 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy -1.905 -1.27) (xy -1.905 1.27)) (stroke (width 0.508) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 1.905 -1.27) (xy 1.905 1.27)) (stroke (width 0.508) (type default)) (fill (type none)))"#,
                    r#"(polyline (pts (xy 2.54 0) (xy 1.905 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
                ],
                pins: horizontal,
                length: 1.27,
                names: ["1", "2"],
                reference: ("0 3.81 0", ""),
                value: ("0 -3.81 0", ""),
                pin_names: "(pin_names (offset 1.016) (hide yes))",
                bbox: [-3.81, -3.81, 3.81, 3.81],
            },
        }
    }

    fn diode_like(self) -> bool {
        matches!(self, Kind::Diode | Kind::Schottky | Kind::Zener | Kind::Led)
    }
}

/// The redrawn symbol: the graphics unit (`…_0_1`) and the pin unit (`…_1_1`) bodies.
pub struct Redrawn {
    pub kind: Kind,
    pub art: String,
    pub pins: String,
    pub bbox: [f64; 4],
}

/// The Reference and Value properties as KiCad's `Device` symbol places them.
pub fn field_at(kind: Kind) -> [(&'static str, &'static str); 2] {
    let d = kind.device();
    [d.reference, d.value]
}

/// `(pin_names …)` of the `Device` symbol.
pub fn pin_names(kind: Kind) -> &'static str {
    kind.device().pin_names
}

fn words(hint: &str) -> Vec<String> {
    hint.to_ascii_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// What two-pin passive the part is, from its reference prefix and what the listing says.
pub fn kind_of(prefix: &str, hint: &str) -> Option<Kind> {
    let pfx = prefix.trim_end_matches('?').trim().to_ascii_uppercase();
    let w = words(hint);
    let has = |k: &str| w.iter().any(|x| x == k || x.strip_suffix('s') == Some(k));
    let text = hint.to_ascii_lowercase();
    // arrays, networks and anything with more inside are not a single passive
    if ["array", "network", "module", "driver", "controller", "regulator", "oscillator", "sensor", "bridge", "common"].iter().any(|k| has(k)) {
        return None;
    }
    match pfx.as_str() {
        "R" => (!has("thermistor") && !has("varistor") && !has("fuse")).then_some(Kind::Resistor),
        "C" | "CP" | "EC" | "TC" => {
            let polarized = ["tantalum", "electrolytic", "polymer", "polarized", "polarised", "aluminum", "aluminium"].iter().any(|k| has(k))
                && !has("nonpolarized")
                && !text.contains("non-polar")
                && !text.contains("bipolar");
            Some(if polarized || pfx != "C" { Kind::CapacitorPolarized } else { Kind::Capacitor })
        }
        "L" => Some(if has("ferrite") || text.contains("bead") { Kind::FerriteBead } else { Kind::Inductor }),
        "FB" => Some(Kind::FerriteBead),
        "LED" => Some(Kind::Led),
        "D" | "VD" | "DS" | "ZD" | "CR" => {
            if has("led") || text.contains("light emitting") {
                Some(Kind::Led)
            } else if has("tvs") || has("esd") || text.contains("transient") || has("bidirectional") || has("photodiode") || has("varactor") || has("rgb") {
                None
            } else if has("zener") || pfx == "ZD" {
                Some(Kind::Zener)
            } else if has("schottky") {
                Some(Kind::Schottky)
            } else {
                Some(Kind::Diode)
            }
        }
        "X" | "Y" | "XTAL" => ((has("crystal") || has("resonator")) && !has("oscillator")).then_some(Kind::Crystal),
        _ => None,
    }
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// Which of the two pins is pin 1 of the `Device` symbol (the cathode of a diode, + of a capacitor).
fn first_pin(kind: Kind, pins: &[RawPin], tris: &[Tri]) -> Option<usize> {
    let name = |i: usize| pins[i].name.trim().to_ascii_uppercase();
    let is = |i: usize, keys: &[&str]| keys.contains(&name(i).as_str());
    if kind.diode_like() {
        const K: &[&str] = &["K", "C", "CATHODE", "KATHODE", "-", "NEG"];
        const A: &[&str] = &["A", "ANODE", "+", "POS"];
        for i in 0..2 {
            if is(i, K) && is(1 - i, A) {
                return Some(i);
            }
        }
        // the arrowhead points at the cathode: the pin nearer its tip than its base
        let mut votes = [0, 0];
        for t in tris {
            let e = [dist(t[1], t[2]), dist(t[0], t[2]), dist(t[0], t[1])];
            let k = (0..3).min_by(|&a, &b| e[a].partial_cmp(&e[b]).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(0);
            let (a, b) = (t[(k + 1) % 3], t[(k + 2) % 3]);
            let (tip, base) = (t[k], [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]);
            let near = |i: usize| dist([pins[i].x, pins[i].y], tip) - dist([pins[i].x, pins[i].y], base);
            let (n0, n1) = (near(0), near(1));
            if n0 < 0.0 && n1 > 0.0 {
                votes[0] += 1;
            } else if n1 < 0.0 && n0 > 0.0 {
                votes[1] += 1;
            }
        }
        return match votes {
            [a, 0] if a > 0 => Some(0),
            [0, b] if b > 0 => Some(1),
            _ => None,
        };
    }
    if kind == Kind::CapacitorPolarized {
        const P: &[&str] = &["+", "P", "POS", "PLUS", "ANODE", "A"];
        const N: &[&str] = &["-", "N", "NEG", "MINUS", "CATHODE", "K"];
        for i in 0..2 {
            if is(i, P) && is(1 - i, N) {
                return Some(i);
            }
        }
        return None;
    }
    // symmetric: the lower pin number first
    let n = |i: usize| pins[i].number.trim().parse::<i64>().unwrap_or(i64::MAX);
    Some(if n(1) < n(0) { 1 } else { 0 })
}

/// Redraw a two-pin passive as KiCad's `Device` symbol, or `None` to keep the vendor's drawing.
/// `tris` are the filled triangles of the drawing (a diode's arrowhead), in symbol coordinates.
pub fn redraw(pins: &[RawPin], tris: &[Tri], prefix: &str, hint: &str) -> Option<Redrawn> {
    if pins.len() != 2 || pins[0].number.trim() == pins[1].number.trim() || pins.iter().any(|p| p.number.trim().is_empty()) {
        return None;
    }
    let kind = kind_of(prefix, hint)?;
    let first = first_pin(kind, pins, tris)?;
    let d = kind.device();
    let mut art = String::new();
    for g in d.art {
        art.push_str(&format!("\t\t\t{g}\n"));
    }
    let mut out = String::new();
    for (k, i) in [first, 1 - first].into_iter().enumerate() {
        let (x, y, a) = d.pins[k];
        out.push_str(&format!(
            "\t\t\t(pin passive line (at {} {} {a}) (length {}) (name {} (effects (font (size 1.27 1.27)))) (number {} (effects (font (size 1.27 1.27)))))\n",
            fnum(x),
            fnum(y),
            fnum(d.length),
            q(d.names[k]),
            q(pins[i].number.trim()),
        ));
    }
    Some(Redrawn { kind, art, pins: out, bbox: d.bbox })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(name: &str, number: &str, x: f64, y: f64, angle: i32) -> RawPin {
        RawPin { etype: "passive".into(), style: "line".into(), name: name.into(), number: number.into(), x, y, angle }
    }
    fn number_at(r: &Redrawn, at: &str) -> String {
        let l = r.pins.lines().find(|l| l.contains(&format!("(at {at})"))).unwrap();
        l.split("(number \"").nth(1).unwrap().split('"').next().unwrap().to_string()
    }

    #[test]
    fn kinds_from_prefix_and_listing() {
        assert_eq!(kind_of("C?", "22uF 6.3V X7T ±20% 0805 Multilayer Ceramic Capacitors MLCC"), Some(Kind::Capacitor));
        assert_eq!(kind_of("C", "100uF 16V Tantalum Capacitors"), Some(Kind::CapacitorPolarized));
        assert_eq!(kind_of("R", "100kΩ ±1% 0402 Chip Resistor - Surface Mount"), Some(Kind::Resistor));
        assert_eq!(kind_of("R", "8 resistor array 4.7k"), None);
        assert_eq!(kind_of("L", "Ferrite Beads 600Ω@100MHz 0603"), Some(Kind::FerriteBead));
        assert_eq!(kind_of("L", "4.7uH Power Inductors"), Some(Kind::Inductor));
        assert_eq!(kind_of("D", "40V 1A Schottky Barrier Diode SOD-123"), Some(Kind::Schottky));
        assert_eq!(kind_of("D", "Zener Diodes 5.1V"), Some(Kind::Zener));
        assert_eq!(kind_of("LED", "Red 0603 LED"), Some(Kind::Led));
        assert_eq!(kind_of("D", "TVS Diode 5V unidirectional"), None);
        assert_eq!(kind_of("X", "Crystals 12MHz 20pF"), Some(Kind::Crystal));
        assert_eq!(kind_of("U", "Capacitor"), None);
    }

    #[test]
    fn capacitor_keeps_the_vendor_numbers() {
        let pins = vec![pin("2", "2", 5.08, 0.0, 180), pin("1", "1", -5.08, 0.0, 0)];
        let r = redraw(&pins, &[], "C", "MLCC capacitor").unwrap();
        assert_eq!(r.kind, Kind::Capacitor);
        assert_eq!((number_at(&r, "0 3.81 270"), number_at(&r, "0 -3.81 90")), ("1".into(), "2".into()));
        assert!(r.art.contains("(xy -2.032 0.762) (xy 2.032 0.762)"));
    }

    #[test]
    fn diode_cathode_from_names_or_the_arrow() {
        let named = vec![pin("A", "2", -5.0, 0.0, 0), pin("K", "1", 5.0, 0.0, 180)];
        let r = redraw(&named, &[], "D", "switching diode").unwrap();
        assert_eq!((number_at(&r, "-3.81 0 0"), number_at(&r, "3.81 0 180")), ("1".into(), "2".into()));
        // numbered pins: the arrow points right, at pin 2 — that is the cathode
        let numbered = vec![pin("1", "1", -5.0, 0.0, 0), pin("2", "2", 5.0, 0.0, 180)];
        let arrow: Tri = [[1.0, 0.0], [-1.0, 1.0], [-1.0, -1.0]];
        let r = redraw(&numbered, &[arrow], "D", "rectifier diode").unwrap();
        assert_eq!(number_at(&r, "-3.81 0 0"), "2");
        // nothing tells: the vendor's drawing stays
        assert!(redraw(&numbered, &[], "D", "rectifier diode").is_none());
        // a polarized capacitor without +/- names stays too
        assert!(redraw(&numbered, &[], "C", "tantalum capacitor").is_none());
    }
}
