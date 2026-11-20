//! Standard hardware, drawn from its standard's nominal dimensions: no network, no supplier.
//!
//! "M5x20 socket head", "DIN 912 M5x20", "1/4-20 x 1 button head", "M4 nut", "608 bearing" and
//! "2020 extrusion 300" each name a part whose shape a standard fixes.  `search` reads such a
//! query, `part_studio` writes the part as a part studio (a `.jpart`: sketches, a revolve, an
//! extrude) that Junction's own kernel builds, so the result is real B-rep with true cylinders
//! and flat faces to mate on, and it can be edited like any part.
//!
//! What is drawn: socket head, button head, countersunk, hex head and set screws; hex nuts; flat
//! washers; dowel pins; hex standoffs; deep-groove ball bearings and LM..UU linear bearings; square
//! T-slot extrusions.  Metric sizes follow ISO (4762, 7380, 10642, 4017, 4026, 4032, 7089, 2338,
//! 15), inch sizes ASME B18.3, B18.2.1 and B18.2.2.  Threads are not modelled (the shank is a plain
//! cylinder of the nominal diameter), head markings and knurls are left out, and a T-slot profile
//! is a plain one of its size, not a particular maker's.

use serde_json::{json, Map, Value};

// ------------------------------------------------------------------ tables

/// One thread size, every length in the size's own unit (`unit` millimetres each).
#[derive(Debug)]
pub struct Thread {
    /// "M5", "1/4", "#8"
    pub name: &'static str,
    /// millimetres per unit of this row: 1 for metric, 25.4 for inch
    unit: f64,
    d: f64,
    /// coarse pitch (metric), or the threads per inch this size comes in, coarse first
    pitch: f64,
    tpi: &'static [&'static str],
    /// socket head: head diameter, hex key, socket depth (the head is as high as the thread is wide)
    shcs: [f64; 3],
    /// hex head: across flats, head height
    hex: [f64; 2],
    /// hex nut: across flats, height
    nut: [f64; 2],
    /// flat washer: hole, outside diameter, thickness
    washer: [f64; 3],
    /// button head: head diameter, head height, hex key, socket depth
    button: [f64; 4],
    /// countersunk: head diameter, hex key, socket depth
    flat: [f64; 3],
    /// set screw: hex key
    set: f64,
}

const NO2: [f64; 2] = [0.0; 2];
const NO3: [f64; 3] = [0.0; 3];
const NO4: [f64; 4] = [0.0; 4];

macro_rules! metric {
    ($name:expr, $d:expr, $p:expr, $shcs:expr, $hex:expr, $nut:expr, $washer:expr, $button:expr, $flat:expr, $set:expr) => {
        Thread { name: $name, unit: 1.0, d: $d, pitch: $p, tpi: &[], shcs: $shcs, hex: $hex, nut: $nut, washer: $washer, button: $button, flat: $flat, set: $set }
    };
}
macro_rules! inch {
    ($name:expr, $d:expr, $tpi:expr, $shcs:expr, $hex:expr, $nut:expr, $washer:expr, $button:expr, $flat:expr, $set:expr) => {
        Thread { name: $name, unit: 25.4, d: $d, pitch: 0.0, tpi: $tpi, shcs: $shcs, hex: $hex, nut: $nut, washer: $washer, button: $button, flat: $flat, set: $set }
    };
}

pub static THREADS: &[Thread] = &[
    //      name    d    pitch  socket head (dk, s, t)  hex (s, k)   nut (s, m)   washer (d1, d2, h)  button (dk, k, s, t)      countersunk (dk, s, t)  set (s)
    metric!("M1.6", 1.6, 0.35, [3.0, 1.5, 0.7], [3.2, 1.1], [3.2, 1.3], [1.7, 4.0, 0.3], NO4, NO3, 0.7),
    metric!("M2", 2.0, 0.4, [3.8, 1.5, 1.0], [4.0, 1.4], [4.0, 1.6], [2.2, 5.0, 0.3], NO4, NO3, 0.9),
    metric!("M2.5", 2.5, 0.45, [4.5, 2.0, 1.1], [5.0, 1.7], [5.0, 2.0], [2.7, 6.0, 0.5], NO4, NO3, 1.3),
    metric!("M3", 3.0, 0.5, [5.5, 2.5, 1.3], [5.5, 2.0], [5.5, 2.4], [3.2, 7.0, 0.5], [5.7, 1.65, 2.0, 1.04], [6.0, 2.0, 1.1], 1.5),
    metric!("M4", 4.0, 0.7, [7.0, 3.0, 2.0], [7.0, 2.8], [7.0, 3.2], [4.3, 9.0, 0.8], [7.6, 2.2, 2.5, 1.3], [8.0, 2.5, 1.5], 2.0),
    metric!("M5", 5.0, 0.8, [8.5, 4.0, 2.5], [8.0, 3.5], [8.0, 4.7], [5.3, 10.0, 1.0], [9.5, 2.75, 3.0, 1.56], [10.0, 3.0, 1.9], 2.5),
    metric!("M6", 6.0, 1.0, [10.0, 5.0, 3.0], [10.0, 4.0], [10.0, 5.2], [6.4, 12.0, 1.6], [10.5, 3.3, 4.0, 2.08], [12.0, 4.0, 2.2], 3.0),
    metric!("M8", 8.0, 1.25, [13.0, 6.0, 4.0], [13.0, 5.3], [13.0, 6.8], [8.4, 16.0, 1.6], [14.0, 4.4, 5.0, 2.6], [16.0, 5.0, 3.0], 4.0),
    metric!("M10", 10.0, 1.5, [16.0, 8.0, 5.0], [16.0, 6.4], [16.0, 8.4], [10.5, 20.0, 2.0], [17.5, 5.5, 6.0, 3.12], [20.0, 6.0, 3.6], 5.0),
    metric!("M12", 12.0, 1.75, [18.0, 10.0, 6.0], [18.0, 7.5], [18.0, 10.8], [13.0, 24.0, 2.5], [21.0, 6.6, 8.0, 4.16], [24.0, 8.0, 4.3], 6.0),
    metric!("M14", 14.0, 2.0, [21.0, 12.0, 7.0], [21.0, 8.8], [21.0, 12.8], [15.0, 28.0, 2.5], NO4, NO3, 6.0),
    metric!("M16", 16.0, 2.0, [24.0, 14.0, 8.0], [24.0, 10.0], [24.0, 14.8], [17.0, 30.0, 3.0], [28.0, 8.8, 10.0, 5.2], [30.0, 10.0, 4.8], 8.0),
    metric!("M20", 20.0, 2.5, [30.0, 17.0, 10.0], [30.0, 12.5], [30.0, 18.0], [21.0, 37.0, 3.0], NO4, [36.0, 12.0, 5.6], 10.0),
    metric!("M24", 24.0, 3.0, [36.0, 19.0, 12.0], [36.0, 15.0], [36.0, 21.5], [25.0, 44.0, 4.0], NO4, NO3, 12.0),
    //    name   d       tpi             socket head            hex            nut               washer                 button                        countersunk       set
    inch!("#0", 0.060, &["80"], [0.096, 0.050, 0.030], NO2, [0.15625, 0.046875], [0.078, 0.188, 0.020], NO4, NO3, 0.028),
    inch!("#2", 0.086, &["56", "64"], [0.140, 0.078125, 0.043], NO2, [0.1875, 0.0625], [0.094, 0.250, 0.020], [0.164, 0.046, 0.050, 0.028], NO3, 0.035),
    inch!("#4", 0.112, &["40", "48"], [0.183, 0.09375, 0.056], NO2, [0.25, 0.09375], [0.125, 0.312, 0.032], [0.213, 0.059, 0.0625, 0.035], [0.255, 0.0625, 0.055], 0.050),
    inch!("#6", 0.138, &["32", "40"], [0.226, 0.109375, 0.069], NO2, [0.3125, 0.109375], [0.156, 0.375, 0.049], [0.262, 0.073, 0.078125, 0.044], [0.307, 0.078125, 0.058], 0.0625),
    inch!("#8", 0.164, &["32", "36"], [0.270, 0.140625, 0.082], NO2, [0.34375, 0.125], [0.188, 0.438, 0.049], [0.312, 0.087, 0.09375, 0.052], [0.359, 0.09375, 0.066], 0.078125),
    inch!("#10", 0.190, &["24", "32"], [0.312, 0.15625, 0.095], NO2, [0.375, 0.125], [0.219, 0.500, 0.049], [0.361, 0.101, 0.125, 0.070], [0.411, 0.125, 0.076], 0.09375),
    inch!("1/4", 0.250, &["20", "28"], [0.375, 0.1875, 0.125], [0.4375, 0.163], [0.4375, 0.21875], [0.281, 0.625, 0.065], [0.437, 0.132, 0.15625, 0.087], [0.531, 0.15625, 0.111], 0.125),
    inch!("5/16", 0.3125, &["18", "24"], [0.469, 0.25, 0.156], [0.5, 0.211], [0.5, 0.265625], [0.344, 0.688, 0.065], [0.547, 0.166, 0.1875, 0.105], [0.656, 0.1875, 0.135], 0.15625),
    inch!("3/8", 0.375, &["16", "24"], [0.562, 0.3125, 0.188], [0.5625, 0.243], [0.5625, 0.328125], [0.406, 0.812, 0.065], [0.656, 0.199, 0.21875, 0.122], [0.781, 0.21875, 0.159], 0.1875),
    inch!("7/16", 0.4375, &["14", "20"], [0.656, 0.375, 0.219], [0.625, 0.291], [0.6875, 0.375], [0.469, 0.922, 0.065], NO4, NO3, 0.21875),
    inch!("1/2", 0.5, &["13", "20"], [0.750, 0.375, 0.250], [0.75, 0.323], [0.75, 0.4375], [0.531, 1.062, 0.095], [0.875, 0.265, 0.3125, 0.175], [0.938, 0.3125, 0.172], 0.25),
    inch!("5/8", 0.625, &["11", "18"], [0.938, 0.5, 0.312], [0.9375, 0.403], [0.9375, 0.546875], [0.656, 1.312, 0.095], NO4, NO3, 0.3125),
];

impl Thread {
    pub fn inch(&self) -> bool { self.unit > 1.0 }
    fn mm(&self, v: f64) -> f64 { v * self.unit }
    /// nominal diameter, millimetres
    pub fn dia(&self) -> f64 { self.mm(self.d) }
    fn pitch_mm(&self) -> f64 {
        if self.inch() { 25.4 / self.tpi.first().and_then(|t| t.parse::<f64>().ok()).unwrap_or(20.0) } else { self.pitch }
    }
    /// "M5", `1/4"-20`, "#8-32"
    fn label(&self, tpi: &str) -> String {
        if !self.inch() { return self.name.to_string(); }
        let tpi = if tpi.is_empty() { self.tpi[0] } else { tpi };
        if self.name.starts_with('#') { format!("{}-{tpi}", self.name) } else { format!("{}\"-{tpi}", self.name) }
    }
    /// The same without the inch mark, for a part number: "1/4-20"
    fn plain(&self, tpi: &str) -> String { self.label(tpi).replace('"', "") }
}

fn thread(name: &str) -> Option<&'static Thread> { THREADS.iter().find(|t| t.name.eq_ignore_ascii_case(name)) }

/// Deep-groove ball bearings by their basic designation: bore, outside diameter, width (ISO 15).
static BEARINGS: &[(&str, [f64; 3])] = &[
    ("623", [3.0, 10.0, 4.0]), ("624", [4.0, 13.0, 5.0]), ("625", [5.0, 16.0, 5.0]), ("626", [6.0, 19.0, 6.0]), ("627", [7.0, 22.0, 7.0]),
    ("608", [8.0, 22.0, 7.0]), ("609", [9.0, 24.0, 7.0]), ("629", [9.0, 26.0, 8.0]),
    ("6000", [10.0, 26.0, 8.0]), ("6001", [12.0, 28.0, 8.0]), ("6002", [15.0, 32.0, 9.0]), ("6003", [17.0, 35.0, 10.0]), ("6004", [20.0, 42.0, 12.0]),
    ("6005", [25.0, 47.0, 12.0]), ("6006", [30.0, 55.0, 13.0]), ("6007", [35.0, 62.0, 14.0]), ("6008", [40.0, 68.0, 15.0]),
    ("6200", [10.0, 30.0, 9.0]), ("6201", [12.0, 32.0, 10.0]), ("6202", [15.0, 35.0, 11.0]), ("6203", [17.0, 40.0, 12.0]), ("6204", [20.0, 47.0, 14.0]),
    ("6205", [25.0, 52.0, 15.0]), ("6206", [30.0, 62.0, 16.0]), ("6207", [35.0, 72.0, 17.0]), ("6208", [40.0, 80.0, 18.0]),
    ("6300", [10.0, 35.0, 11.0]), ("6301", [12.0, 37.0, 12.0]), ("6302", [15.0, 42.0, 13.0]), ("6303", [17.0, 47.0, 14.0]), ("6304", [20.0, 52.0, 15.0]),
    ("6800", [10.0, 19.0, 5.0]), ("6801", [12.0, 21.0, 5.0]), ("6802", [15.0, 24.0, 5.0]), ("6803", [17.0, 26.0, 5.0]), ("6804", [20.0, 32.0, 7.0]), ("6805", [25.0, 37.0, 7.0]),
    ("6900", [10.0, 22.0, 6.0]), ("6901", [12.0, 24.0, 6.0]), ("6902", [15.0, 28.0, 7.0]), ("6903", [17.0, 30.0, 7.0]), ("6904", [20.0, 37.0, 9.0]), ("6905", [25.0, 42.0, 9.0]),
    ("683", [3.0, 7.0, 3.0]), ("684", [4.0, 9.0, 4.0]), ("685", [5.0, 11.0, 5.0]), ("686", [6.0, 13.0, 5.0]), ("687", [7.0, 14.0, 5.0]), ("688", [8.0, 16.0, 5.0]), ("689", [9.0, 17.0, 5.0]),
    ("693", [3.0, 8.0, 4.0]), ("694", [4.0, 11.0, 4.0]), ("695", [5.0, 13.0, 4.0]), ("696", [6.0, 15.0, 5.0]), ("697", [7.0, 17.0, 5.0]), ("698", [8.0, 19.0, 6.0]),
    ("MR63", [3.0, 6.0, 2.5]), ("MR74", [4.0, 7.0, 2.5]), ("MR84", [4.0, 8.0, 3.0]), ("MR85", [5.0, 8.0, 2.5]), ("MR105", [5.0, 10.0, 4.0]), ("MR115", [5.0, 11.0, 4.0]),
    ("MR106", [6.0, 10.0, 3.0]), ("MR126", [6.0, 12.0, 4.0]), ("MR128", [8.0, 12.0, 3.5]), ("MR148", [8.0, 14.0, 4.0]),
];

/// Linear ball bushings: shaft, outside diameter, length.
static LINEAR: &[(&str, [f64; 3])] = &[
    ("LM3UU", [3.0, 7.0, 10.0]), ("LM4UU", [4.0, 8.0, 12.0]), ("LM5UU", [5.0, 10.0, 15.0]), ("LM6UU", [6.0, 12.0, 19.0]), ("LM8UU", [8.0, 15.0, 24.0]),
    ("LM10UU", [10.0, 19.0, 29.0]), ("LM12UU", [12.0, 21.0, 30.0]), ("LM16UU", [16.0, 28.0, 37.0]), ("LM20UU", [20.0, 32.0, 42.0]), ("LM25UU", [25.0, 40.0, 59.0]),
];

/// Square T-slot extrusions by the side: slot opening, widest part of the slot, lip thickness,
/// how far the full width runs under the lip, slot depth, centre bore.
static TSLOTS: &[(u32, [f64; 6])] = &[
    (20, [6.0, 11.0, 1.8, 1.6, 6.1, 4.2]),
    (30, [8.0, 16.5, 2.0, 2.0, 9.0, 6.8]),
    (40, [8.0, 20.0, 4.5, 3.0, 12.5, 6.8]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind { Shcs, Button, Flat, Hex, Set, Nut, Washer, Dowel, Standoff, Bearing, Linear, TSlot }

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Shcs => "shcs", Kind::Button => "button", Kind::Flat => "flat", Kind::Hex => "hex", Kind::Set => "set", Kind::Nut => "nut",
            Kind::Washer => "washer", Kind::Dowel => "dowel", Kind::Standoff => "standoff", Kind::Bearing => "bearing", Kind::Linear => "linear", Kind::TSlot => "tslot",
        }
    }
    fn parse(s: &str) -> Option<Kind> {
        [Kind::Shcs, Kind::Button, Kind::Flat, Kind::Hex, Kind::Set, Kind::Nut, Kind::Washer, Kind::Dowel, Kind::Standoff, Kind::Bearing, Kind::Linear, Kind::TSlot].into_iter().find(|k| k.key() == s)
    }
    fn has_length(self) -> bool { matches!(self, Kind::Shcs | Kind::Button | Kind::Flat | Kind::Hex | Kind::Set | Kind::Dowel | Kind::Standoff | Kind::TSlot) }
    fn word(self) -> &'static str {
        match self {
            Kind::Shcs => "Socket head cap screw", Kind::Button => "Button head screw", Kind::Flat => "Countersunk screw", Kind::Hex => "Hex head screw", Kind::Set => "Set screw",
            Kind::Nut => "Hex nut", Kind::Washer => "Flat washer", Kind::Dowel => "Dowel pin", Kind::Standoff => "Hex standoff", Kind::Bearing => "Ball bearing",
            Kind::Linear => "Linear bearing", Kind::TSlot => "T-slot extrusion",
        }
    }
    /// The standard that fixes the shape, metric and inch.
    fn standard(self, inch: bool) -> &'static str {
        match (self, inch) {
            (Kind::Shcs, false) => "ISO 4762", (Kind::Shcs, true) => "ASME B18.3 SHCS",
            (Kind::Button, false) => "ISO 7380", (Kind::Button, true) => "ASME B18.3 BHCS",
            (Kind::Flat, false) => "ISO 10642", (Kind::Flat, true) => "ASME B18.3 FHCS",
            (Kind::Hex, false) => "ISO 4017", (Kind::Hex, true) => "ASME B18.2.1",
            (Kind::Set, false) => "ISO 4026", (Kind::Set, true) => "ASME B18.3 SSS",
            (Kind::Nut, false) => "ISO 4032", (Kind::Nut, true) => "ASME B18.2.2",
            (Kind::Washer, false) => "ISO 7089", (Kind::Washer, true) => "SAE washer",
            (Kind::Dowel, _) => "ISO 2338", (Kind::Standoff, _) => "Standoff", (Kind::Bearing, _) => "Bearing", (Kind::Linear, _) => "Linear bearing", (Kind::TSlot, _) => "T-slot",
        }
    }
    /// Other names the same shape goes by, for the description.
    fn also(self, inch: bool) -> &'static str {
        match (self, inch) {
            (Kind::Shcs, false) => "ISO 4762 / DIN 912", (Kind::Button, false) => "ISO 7380", (Kind::Flat, false) => "ISO 10642 / DIN 7991", (Kind::Hex, false) => "ISO 4017 / DIN 933",
            (Kind::Set, false) => "ISO 4026 / DIN 913", (Kind::Nut, false) => "ISO 4032 / DIN 934", (Kind::Washer, false) => "ISO 7089 / DIN 125", (Kind::Dowel, _) => "ISO 2338 / DIN 7",
            (Kind::Shcs | Kind::Button | Kind::Flat | Kind::Set, true) => "ASME B18.3", (Kind::Hex, true) => "ASME B18.2.1", (Kind::Nut, true) => "ASME B18.2.2", (Kind::Washer, true) => "SAE",
            (Kind::Bearing, _) => "ISO 15", _ => "",
        }
    }
}

/// One standard part, fully said.
#[derive(Debug, Clone)]
pub struct Spec {
    pub kind: Kind,
    thread: Option<&'static Thread>,
    /// the threads per inch that was typed ("32" of #10-32); empty for the coarse one and for metric
    tpi: String,
    /// millimetres: a screw's length, a pin's, an extrusion's
    length: f64,
    /// the length was given in inches
    inch_len: bool,
    /// a dowel pin's diameter, an extrusion's side
    size: f64,
    /// a bearing's designation
    name: String,
}

fn fnum(v: f64) -> String {
    let r = (v * 1000.0).round() / 1000.0;
    if (r - r.round()).abs() < 1e-9 { format!("{}", r.round() as i64) } else { format!("{r}") }
}

/// 44.45 mm → "1-3/4": inches to the nearest 64th.
fn inch_text(mm: f64) -> String {
    let n = (mm / 25.4 * 64.0).round() as i64;
    let (whole, mut num, mut den) = (n / 64, n % 64, 64);
    while num != 0 && num % 2 == 0 { num /= 2; den /= 2; }
    match (whole, num) { (w, 0) => format!("{w}"), (0, _) => format!("{num}/{den}"), _ => format!("{whole}-{num}/{den}") }
}

impl Spec {
    fn len_text(&self) -> String { if self.inch_len { inch_text(self.length) } else { fnum(self.length) } }

    /// "shcs:M5:20", "shcs:1/4-20:1.75in", "nut:M5", "bearing:608", "tslot:20:300", "dowel:5:20"
    pub fn id(&self) -> String {
        let len = if self.inch_len { format!("{}in", fnum(self.length / 25.4)) } else { fnum(self.length) };
        match self.kind {
            Kind::Bearing | Kind::Linear => format!("{}:{}", self.kind.key(), self.name),
            Kind::TSlot | Kind::Dowel => format!("{}:{}:{len}", self.kind.key(), fnum(self.size)),
            k => {
                let t = self.thread.map(|t| if self.tpi.is_empty() { t.name.to_string() } else { format!("{}-{}", t.name, self.tpi) }).unwrap_or_default();
                if k.has_length() { format!("{}:{t}:{len}", k.key()) } else { format!("{}:{t}", k.key()) }
            }
        }
    }

    pub fn from_id(id: &str) -> Option<Spec> {
        let mut it = id.split(':');
        let kind = Kind::parse(it.next()?)?;
        let (a, b) = (it.next()?, it.next());
        if it.next().is_some() { return None; }
        let length = |s: Option<&str>| -> Option<(f64, bool)> {
            let s = s?;
            let (v, inch) = match s.strip_suffix("in") { Some(v) => (v.parse::<f64>().ok()? * 25.4, true), None => (s.parse::<f64>().ok()?, false) };
            (v.is_finite() && v > 0.0).then_some((v, inch))
        };
        let mut spec = Spec { kind, thread: None, tpi: String::new(), length: 0.0, inch_len: false, size: 0.0, name: String::new() };
        match kind {
            Kind::Bearing => { spec.name = BEARINGS.iter().find(|(n, _)| n.eq_ignore_ascii_case(a))?.0.to_string(); if b.is_some() { return None; } }
            Kind::Linear => { spec.name = LINEAR.iter().find(|(n, _)| n.eq_ignore_ascii_case(a))?.0.to_string(); if b.is_some() { return None; } }
            Kind::TSlot | Kind::Dowel => { spec.size = a.parse().ok()?; (spec.length, spec.inch_len) = length(b)?; }
            _ => {
                let (t, tpi) = match thread(a) { Some(t) => (t, ""), None => { let (n, tpi) = a.rsplit_once('-')?; (thread(n)?, tpi) } };
                if !tpi.is_empty() && !t.tpi.contains(&tpi) { return None; }
                spec.thread = Some(t);
                spec.tpi = tpi.to_string();
                if kind.has_length() { (spec.length, spec.inch_len) = length(b)?; } else if b.is_some() { return None; }
            }
        }
        spec.valid().then_some(spec)
    }

    /// Whether the standard has such a part, and it can be drawn.
    fn valid(&self) -> bool {
        let len = self.length;
        match self.kind {
            Kind::Bearing | Kind::Linear => true,
            Kind::TSlot => TSLOTS.iter().any(|(s, _)| *s as f64 == self.size) && (5.0..=6000.0).contains(&len),
            Kind::Dowel => (0.8..=50.0).contains(&self.size) && len >= self.size * 0.5 && len <= 400.0,
            k => {
                let Some(t) = self.thread else { return false };
                let d = t.dia();
                match k {
                    Kind::Shcs => (1.0..=600.0).contains(&len),
                    Kind::Hex => t.hex[0] > 0.0 && (1.0..=600.0).contains(&len),
                    Kind::Button => t.button[0] > 0.0 && (1.0..=300.0).contains(&len),
                    // a countersunk screw is measured over its head
                    Kind::Flat => t.flat[0] > 0.0 && len > (t.mm(t.flat[0]) - d) / 2.0 + 0.5 && len <= 300.0,
                    Kind::Set => len >= d * 0.5 && len <= 200.0,
                    Kind::Standoff => (t.hex[0] > 0.0 || t.nut[0] > 0.0) && (2.0..=300.0).contains(&len),
                    _ => true,
                }
            }
        }
    }

    /// What the part is called in a bill of materials: "ISO 4762 M5x20", "ASME B18.3 SHCS 1/4-20 x 1-3/4", "608 bearing".
    pub fn part_number(&self) -> String {
        match self.kind {
            Kind::Bearing => format!("{} bearing", self.name),
            Kind::Linear => self.name.clone(),
            Kind::TSlot => format!("T-slot {0}{0} x {1}", fnum(self.size), self.len_text()),
            Kind::Dowel => format!("ISO 2338 {}x{}", fnum(self.size), self.len_text()),
            k => {
                let t = self.thread.expect("a threaded part has a thread");
                let std = k.standard(t.inch());
                match (k.has_length(), t.inch()) {
                    (true, false) => format!("{std} {}x{}", t.name, self.len_text()),
                    (true, true) => format!("{std} {} x {}", t.plain(&self.tpi), self.len_text()),
                    (false, false) => format!("{std} {}", t.name),
                    (false, true) => format!("{std} {}", if k == Kind::Washer { t.name.to_string() } else { t.plain(&self.tpi) }),
                }
            }
        }
    }

    /// One line saying what it is, with its sizes.
    pub fn description(&self) -> String {
        let unit = if self.inch_len { "\"" } else { " mm" };
        match self.kind {
            Kind::Bearing => { let b = self.bearing(); format!("Deep-groove ball bearing {}: {} × {} × {} mm (ISO 15)", self.name, fnum(b[0]), fnum(b[1]), fnum(b[2])) }
            Kind::Linear => { let b = self.bearing(); format!("Linear ball bushing {}: shaft {} mm, {} × {} mm", self.name, fnum(b[0]), fnum(b[1]), fnum(b[2])) }
            Kind::TSlot => format!("T-slot aluminium extrusion {0} × {0} mm, {1}{unit} long (a plain profile of its size)", fnum(self.size), self.len_text()),
            Kind::Dowel => format!("Dowel pin ⌀{} × {}{unit} (ISO 2338 / DIN 7)", fnum(self.size), self.len_text()),
            k => {
                let t = self.thread.expect("a threaded part has a thread");
                let also = k.also(t.inch());
                let also = if also.is_empty() { String::new() } else { format!(" ({also})") };
                if k.has_length() { format!("{} {} × {}{unit}{also}", k.word(), t.label(&self.tpi), self.len_text()) } else { format!("{} {}{also}", k.word(), t.label(&self.tpi)) }
            }
        }
    }

    /// What the drawing leaves out, for whoever places it.
    pub fn note(&self) -> &'static str {
        match self.kind {
            Kind::Washer | Kind::Dowel => "Drawn by Junction from the standard's dimensions.",
            Kind::Bearing | Kind::Linear => "Drawn by Junction from the standard's dimensions, as one solid: the balls and cage are not modelled.",
            Kind::TSlot => "Drawn by Junction: a plain profile of its size, not a particular maker's.",
            _ => "Drawn by Junction from the standard's dimensions. The thread is not modelled.",
        }
    }

    fn bearing(&self) -> [f64; 3] {
        BEARINGS.iter().chain(LINEAR.iter()).find(|(n, _)| *n == self.name).map(|(_, b)| *b).unwrap_or([8.0, 22.0, 7.0])
    }
}

// ------------------------------------------------------------------ reading a query

fn is_num(s: &str) -> bool { !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '.') && s.chars().any(|c| c.is_ascii_digit()) && s.matches('.').count() <= 1 }

/// "3/4", "1-3/4", "1.5", "2" → inches
fn inch_value(s: &str) -> Option<f64> {
    let frac = |f: &str| -> Option<f64> { let (a, b) = f.split_once('/')?; let (a, b) = (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?); (b > 0.0).then_some(a / b) };
    if is_num(s) { return s.parse().ok(); }
    if let Some((w, f)) = s.split_once('-') { if is_num(w) && !w.contains('.') { return Some(w.parse::<f64>().ok()? + frac(f)?); } }
    frac(s)
}

/// The words of a query: lower case, quotes and unit marks dropped, "m5x20" and "20x20" split at the x.
fn tokens(q: &str) -> Vec<String> {
    let q: String = q.to_lowercase().replace(['×', '*'], "x").replace(['"', '”', '“', '\''], "").replace([',', ';', '(', ')'], " ").replace("mm", " ").replace('⌀', " ");
    let chars: Vec<char> = q.chars().collect();
    let mut out = String::with_capacity(q.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        let digit_before = i > 0 && (chars[i - 1].is_ascii_digit() || chars[i - 1] == ' ');
        let digit_after = chars.get(i + 1).is_some_and(|n| n.is_ascii_digit() || *n == ' ' || *n == '.');
        if c == 'x' && i > 0 && digit_before && digit_after { out.push_str(" x "); } else { out.push(c); }
    }
    out.split_whitespace().map(str::to_string).collect()
}

/// A thread named by one word: "m5", "m5-0.8", "1/4-20", "#8-32", "8-32", "10-24".
fn thread_of(tok: &str) -> Option<(&'static Thread, String)> {
    if let Some(rest) = tok.strip_prefix('m') {
        let size = rest.split('-').next().unwrap_or(rest);
        if is_num(size) { return thread(&format!("M{size}")).map(|t| (t, String::new())); }
        return None;
    }
    let (size, tpi) = tok.rsplit_once('-')?;
    let size = size.trim_end_matches('-');
    if !tpi.chars().all(|c| c.is_ascii_digit()) || tpi.is_empty() { return None; }
    let name = if size.contains('/') { size.to_string() } else if let Some(n) = size.strip_prefix('#') { format!("#{n}") } else if size.chars().all(|c| c.is_ascii_digit()) { format!("#{size}") } else { return None };
    let t = thread(&name)?;
    t.tpi.contains(&tpi).then(|| (t, if tpi == t.tpi[0] { String::new() } else { tpi.to_string() }))
}

/// Which standards name which shape.
fn kind_of_standard(family: &str, number: &str) -> Option<Kind> {
    Some(match (family, number) {
        ("din", "912") | ("iso", "4762") | ("din", "6912") => Kind::Shcs,
        ("iso", "7380") | ("din", "7380") => Kind::Button,
        ("iso", "10642") | ("din", "7991") => Kind::Flat,
        ("din", "933") | ("din", "931") | ("iso", "4017") | ("iso", "4014") => Kind::Hex,
        ("din", "913") | ("din", "914") | ("din", "916") | ("iso", "4026") | ("iso", "4027") | ("iso", "4029") => Kind::Set,
        ("din", "934") | ("iso", "4032") | ("iso", "4033") => Kind::Nut,
        ("din", "125") | ("iso", "7089") | ("iso", "7090") => Kind::Washer,
        ("din", "7") | ("iso", "2338") | ("din", "6325") | ("iso", "8734") => Kind::Dowel,
        ("din", "625") => Kind::Bearing,
        _ => return None,
    })
}

/// What a query asks for.  `kinds` is what it named (empty: it named a size only).
#[derive(Debug, Default)]
struct Asked {
    kinds: Vec<Kind>,
    thread: Option<(&'static Thread, String)>,
    /// the numbers after the thread, as typed: a length, or a pitch and a length
    lengths: Vec<String>,
    /// numbers that belong to nothing else: a dowel's "5 x 20", an extrusion's length
    loose: Vec<f64>,
    bearing: Option<&'static str>,
    linear: Option<&'static str>,
    tslot: Option<u32>,
    inch_words: bool,
}

fn read(q: &str) -> Asked {
    let toks = tokens(q);
    let text = format!(" {} ", toks.join(" "));
    let mut a = Asked::default();
    let has = |w: &str| text.contains(w);
    let add = |a: &mut Asked, k: Kind| if !a.kinds.contains(&k) { a.kinds.push(k) };
    // "button head cap screw" and "hex cap screw" are not socket heads: the plainer name comes last
    if has("button") || has(" bhcs ") { add(&mut a, Kind::Button); }
    if has("flat head") || has("countersunk") || has(" csk ") || has(" fhcs ") || has("flathead") { add(&mut a, Kind::Flat); }
    if has("hex bolt") || has("hex head") || has("hex cap") || has(" bolt ") || has("hex screw") { add(&mut a, Kind::Hex); }
    if a.kinds.is_empty() && (has("socket head") || has(" shcs ") || has("cap screw") || has("socket cap") || has("allen")) { add(&mut a, Kind::Shcs); }
    if has("set screw") || has("grub") || has("setscrew") { add(&mut a, Kind::Set); }
    if has(" nut ") || has("hex nut") || has(" nuts ") { add(&mut a, Kind::Nut); }
    if has("washer") { add(&mut a, Kind::Washer); }
    if has("dowel") { add(&mut a, Kind::Dowel); }
    if has("standoff") || has("spacer") { add(&mut a, Kind::Standoff); }
    if has("bearing") { add(&mut a, Kind::Bearing); }
    if has("extrusion") || has("t-slot") || has("tslot") || has("t slot") || has("profile") || has("v-slot") { add(&mut a, Kind::TSlot); }
    a.inch_words = has(" in ") || has(" inch ");

    let mut i = 0;
    while i < toks.len() {
        let t = toks[i].as_str();
        // "din 912", "din912", "iso 4762", "iso4762"
        let standard = ["din", "iso"].into_iter().find_map(|fam| {
            let number = if t == fam { toks.get(i + 1).map(String::as_str) } else { t.strip_prefix(fam).filter(|n| n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty()) };
            number.and_then(|n| kind_of_standard(fam, n)).map(|k| (k, if t == fam { 2 } else { 1 }))
        });
        if let Some((k, used)) = standard {
            // the standard says more than a word does: "DIN 933 screw" is a hex head
            a.kinds.retain(|have| *have != k);
            a.kinds.insert(0, k);
            i += used;
            continue;
        }
        if a.thread.is_none() {
            if let Some(found) = thread_of(t) {
                a.thread = Some(found);
                // "x 20", "x 0.8 x 20", "x 1-3/4", "x 1 3/4"
                let mut j = i + 1;
                while toks.get(j).map(String::as_str) == Some("x") {
                    let Some(v) = toks.get(j + 1) else { break };
                    if inch_value(v).is_none() { break; }
                    let mut val = v.clone();
                    // a whole number of inches and then a fraction: "1 3/4"
                    if let Some(f) = toks.get(j + 2) { if is_num(v) && !v.contains('.') && f.contains('/') && inch_value(f).is_some() { val = format!("{v}-{f}"); j += 1; } }
                    a.lengths.push(val);
                    j += 2;
                }
                i = j;
                continue;
            }
        }
        let bare = t.trim_end_matches("-2rs").trim_end_matches("2rs").trim_end_matches("-zz").trim_end_matches("zz").trim_end_matches("-rs").trim_end_matches("rs").trim_end_matches('z').trim_end_matches('-');
        if a.bearing.is_none() { if let Some((n, _)) = BEARINGS.iter().find(|(n, _)| n.eq_ignore_ascii_case(bare)) { a.bearing = Some(n); i += 1; continue; } }
        if a.linear.is_none() { if let Some((n, _)) = LINEAR.iter().find(|(n, _)| n.eq_ignore_ascii_case(t)) { a.linear = Some(n); i += 1; continue; } }
        if a.tslot.is_none() {
            // "2020", "3030", "20 x 20"
            let side = TSLOTS.iter().map(|(s, _)| *s).find(|s| t == format!("{s}{s}") || (t == s.to_string() && toks.get(i + 1).map(String::as_str) == Some("x") && toks.get(i + 2) == Some(&s.to_string())));
            if let Some(s) = side {
                a.tslot = Some(s);
                i += if t.len() == 4 { 1 } else { 3 };
                continue;
            }
        }
        if is_num(t) { if let Ok(v) = t.parse::<f64>() { a.loose.push(v); } }
        i += 1;
    }
    a
}

/// The lengths a screw of this diameter is usually kept in, millimetres.
fn usual_lengths(t: &Thread) -> Vec<(f64, bool)> {
    let d = t.dia();
    if t.inch() {
        [0.25, 0.375, 0.5, 0.75, 1.0, 1.5, 2.0].iter().map(|l| (l * 25.4, true)).filter(|(l, _)| *l >= d * 1.4 && *l <= d * 12.0).take(4).collect()
    } else {
        [4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 16.0, 20.0, 25.0, 30.0, 40.0, 50.0, 60.0, 80.0].iter().map(|l| (*l, false)).filter(|(l, _)| *l >= d * 1.9 && *l <= d * 12.0).take(4).collect()
    }
}

/// The standard parts a query names, the likeliest first.
pub fn search(q: &str, limit: usize) -> Vec<Spec> {
    let a = read(q);
    let mut out: Vec<Spec> = Vec::new();
    let blank = |kind: Kind| Spec { kind, thread: None, tpi: String::new(), length: 0.0, inch_len: false, size: 0.0, name: String::new() };
    let push = |out: &mut Vec<Spec>, s: Spec| if s.valid() && !out.iter().any(|o| o.id() == s.id()) { out.push(s) };

    if let Some(n) = a.bearing { push(&mut out, Spec { name: n.to_string(), ..blank(Kind::Bearing) }); }
    if let Some(n) = a.linear { push(&mut out, Spec { name: n.to_string(), ..blank(Kind::Linear) }); }
    if let Some(side) = a.tslot {
        let named: Vec<f64> = a.loose.iter().copied().filter(|v| *v >= 5.0).collect();
        // a side alone is not yet an extrusion ("2020" could be anything) unless it is the whole query or was called one
        if a.kinds.contains(&Kind::TSlot) || !named.is_empty() || tokens(q).len() == 1 {
            for len in if named.is_empty() { vec![100.0, 200.0, 300.0, 500.0] } else { named } { push(&mut out, Spec { size: side as f64, length: len, ..blank(Kind::TSlot) }); }
        }
    }
    if let Some((t, tpi)) = &a.thread {
        // the numbers after the thread: the last is the length; one before it is the pitch
        let typed: Option<(f64, bool)> = a.lengths.last().and_then(|l| {
            let v = inch_value(l)?;
            // "m5 x 0.8": a pitch, not a screw 0.8 long
            if !t.inch() && a.lengths.len() == 1 && (v - t.pitch).abs() < 1e-9 && v < t.d * 0.5 { return None; }
            Some(if t.inch() || a.inch_words { (v * 25.4, true) } else { (v, false) })
        });
        let with = |kind: Kind, len: Option<(f64, bool)>| Spec { thread: Some(t), tpi: tpi.clone(), length: len.map(|l| l.0).unwrap_or(0.0), inch_len: len.map(|l| l.1).unwrap_or(false), ..blank(kind) };
        let threaded: Vec<Kind> = a.kinds.iter().copied().filter(|k| !matches!(k, Kind::Bearing | Kind::Linear | Kind::TSlot | Kind::Dowel)).collect();
        let kinds: Vec<Kind> = if !threaded.is_empty() { threaded } else if typed.is_some() { vec![Kind::Shcs, Kind::Button, Kind::Flat, Kind::Hex, Kind::Set] } else { vec![Kind::Nut, Kind::Washer, Kind::Shcs] };
        for k in kinds {
            if !k.has_length() { push(&mut out, with(k, None)); continue; }
            match typed {
                Some(len) => push(&mut out, with(k, Some(len))),
                None => for len in usual_lengths(t) { push(&mut out, with(k, Some(len))); },
            }
        }
        if a.kinds.contains(&Kind::Dowel) { if let Some(len) = typed { push(&mut out, Spec { size: t.dia(), length: len.0, inch_len: len.1, ..blank(Kind::Dowel) }); } }
    } else if a.kinds.contains(&Kind::Dowel) && a.loose.len() >= 2 {
        push(&mut out, Spec { size: a.loose[0], length: a.loose[1], ..blank(Kind::Dowel) });
    }
    out.truncate(limit.max(1));
    out
}

// ------------------------------------------------------------------ drawing

type P = [f64; 2];

/// A sketch being written: points and curves, ids in the order they are made.
#[derive(Default)]
struct Sk { ents: Map<String, Value>, n: usize }

impl Sk {
    fn pt(&mut self, p: P) -> String {
        self.n += 1;
        let id = format!("p{}", self.n);
        self.ents.insert(id.clone(), json!({ "type": "point", "x": round(p[0]), "y": round(p[1]) }));
        id
    }
    /// A point kept to full precision: an arc's centre, which must be as far from its end as from its start.
    fn pt_exact(&mut self, p: P) -> String {
        self.n += 1;
        let id = format!("p{}", self.n);
        self.ents.insert(id.clone(), json!({ "type": "point", "x": p[0], "y": p[1] }));
        id
    }
    fn curve(&mut self, v: Value) { self.n += 1; self.ents.insert(format!("c{}", self.n), v); }
    /// A closed outline of straight lines.
    fn poly(&mut self, pts: &[P]) {
        let ids: Vec<String> = pts.iter().map(|p| self.pt(*p)).collect();
        for i in 0..ids.len() { let (a, b) = (&ids[i], &ids[(i + 1) % ids.len()]); self.curve(json!({ "type": "line", "a": a, "b": b })); }
    }
    fn circle(&mut self, c: P, r: f64) { let id = self.pt(c); self.curve(json!({ "type": "circle", "center": id, "r": round(r) })); }
    fn data(self) -> Value { json!({ "version": 1, "entities": Value::Object(self.ents), "constraints": {} }) }
}

fn round(v: f64) -> f64 { let r = (v * 1e6).round() / 1e6; if r == 0.0 { 0.0 } else { r } }

/// A regular hexagon by its width across flats, two flats level.
fn hexagon(s: f64) -> Vec<P> {
    let r = s / 3f64.sqrt();
    (0..6).map(|i| { let a = std::f64::consts::PI / 3.0 * i as f64; [r * a.cos(), r * a.sin()] }).collect()
}

/// The features of a part studio, in order.
#[derive(Default)]
struct Studio { features: Vec<Value> }

impl Studio {
    fn push(&mut self, id: &str, kind: &str, name: &str, params: Value) {
        // order keys: one upper-case letter each, in the order the features are made
        let order = ((b'B' + self.features.len() as u8) as char).to_string();
        self.features.push(json!({ "id": id, "type": "feature", "featureType": kind, "name": name, "order": order, "params": params }));
    }
    fn sketch(&mut self, id: &str, name: &str, plane: Value, sk: Sk) { self.push(id, "sketch", name, json!({ "plane": plane, "sketch": sk.data() })); }
    /// A sketch turned all the way about its own vertical axis (the model's Z, for a sketch on Front).
    fn revolve(&mut self, id: &str, name: &str, sketch: &str, operation: &str) {
        self.push(id, "revolve", name, json!({ "bodyType": "solid", "profile": { "sketch": sketch, "regions": null }, "operation": operation, "axisType": "y", "axisEdge": null, "endType": "full", "angle": 360, "flip": false, "targets": [] }));
    }
    fn extrude(&mut self, id: &str, name: &str, sketch: &str, operation: &str, depth: f64, flip: bool) {
        self.push(id, "extrude", name, json!({
            "bodyType": "solid", "profile": { "sketch": sketch, "regions": null }, "operation": operation, "endType": "blind", "depth": round(depth), "face": null, "flip": flip,
            "second": false, "secondType": "blind", "secondDepth": 10, "draft": false, "draftAngle": 3, "thin": false, "thickness": 1, "thinSide": "inside", "targets": [],
        }));
    }
    /// A plane level with Top, `z` above it.
    fn plane(&mut self, id: &str, name: &str, z: f64) {
        self.push(id, "plane", name, json!({ "method": "offset", "ref": { "kind": "plane", "plane": "top" }, "distance": round(z), "flip": false, "points": [], "faces": [], "axis": null, "angle": 45, "curve": null, "position": 0, "cylinder": null }));
    }
    /// A hex socket `depth` deep, cut down from the height `z`.
    fn socket(&mut self, z: f64, key: f64, depth: f64) {
        let plane = if z.abs() < 1e-9 { json!({ "kind": "plane", "plane": "top" }) } else { self.plane("socket-plane", "Socket plane", z); json!({ "kind": "datum", "feature": "socket-plane" }) };
        let mut sk = Sk::default();
        sk.poly(&hexagon(key));
        self.sketch("socket-sketch", "Socket outline", plane, sk);
        self.extrude("socket", "Socket", "socket-sketch", "remove", depth, true);
    }
    /// A profile on Front, x the radius and y the height, turned about the axis.
    fn turned(&mut self, name: &str, profile: Sk, operation: &str) {
        let id = if operation == "new" { "profile" } else { "shank-profile" };
        self.sketch(id, &format!("{name} profile"), json!({ "kind": "plane", "plane": "front" }), profile);
        self.revolve(if operation == "new" { "body" } else { "shank" }, name, id, operation);
    }
}

/// A drawn part: its features, and its outline for a small picture (closed loops, filled even-odd).
struct Drawn { studio: Studio, loops: Vec<Vec<P>> }

fn circle_loop(c: P, r: f64) -> Vec<P> { (0..48).map(|i| { let a = std::f64::consts::TAU * i as f64 / 48.0; [c[0] + r * a.cos(), c[1] + r * a.sin()] }).collect() }
/// A half profile (x ≥ 0) and its mirror image as one outline: a turned part seen from the side.
fn mirrored(half: &[P]) -> Vec<P> { half.iter().copied().chain(half.iter().rev().map(|p| [-p[0], p[1]])).collect() }

fn draw(spec: &Spec) -> Drawn {
    let mut st = Studio::default();
    let mut loops: Vec<Vec<P>> = Vec::new();
    let len = spec.length;
    match spec.kind {
        Kind::Shcs | Kind::Button | Kind::Flat | Kind::Set => {
            let t = spec.thread.expect("thread");
            let d = t.dia();
            let c = (d * 0.08).min(t.pitch_mm());   // the chamfer at the point
            let mut sk = Sk::default();
            let (half, top, key, depth): (Vec<P>, f64, f64, f64) = match spec.kind {
                Kind::Shcs => {
                    let (dk, k, e) = (t.mm(t.shcs[0]), d, d * 0.06);
                    (vec![[0.0, -len], [d / 2.0 - c, -len], [d / 2.0, -len + c], [d / 2.0, 0.0], [dk / 2.0, 0.0], [dk / 2.0, k - e], [dk / 2.0 - e, k], [0.0, k]], k, t.mm(t.shcs[1]), t.mm(t.shcs[2]))
                }
                Kind::Button => {
                    let (dk, k) = (t.mm(t.button[0]), t.mm(t.button[1]));
                    (vec![[0.0, -len], [d / 2.0 - c, -len], [d / 2.0, -len + c], [d / 2.0, 0.0], [dk / 2.0, 0.0], [dk / 2.0, k * 0.2], [t.mm(t.button[2]) * 0.75, k], [0.0, k]], k, t.mm(t.button[2]), t.mm(t.button[3]))
                }
                Kind::Flat => {
                    // measured over the head: the top of the head is at 0 and everything hangs below it
                    let dk = t.mm(t.flat[0]);
                    let land = dk * 0.02;
                    let slope = if t.inch() { (41f64).to_radians().tan() } else { 1.0 };   // 82° inch, 90° metric
                    let k = (dk - d) / 2.0 / slope + land;
                    (vec![[0.0, -len], [d / 2.0 - c, -len], [d / 2.0, -len + c], [d / 2.0, -k], [dk / 2.0, -land], [dk / 2.0, 0.0], [0.0, 0.0]], 0.0, t.mm(t.flat[1]), t.mm(t.flat[2]))
                }
                _ => (vec![[0.0, -len], [d / 2.0 - c, -len], [d / 2.0, -len + c], [d / 2.0, -c], [d / 2.0 - c, 0.0], [0.0, 0.0]], 0.0, t.mm(t.set), (d * 0.6).min(len * 0.5)),
            };
            if spec.kind == Kind::Button {
                // the dome: an arc from the rim to the flat round the socket, its centre on the axis
                let (a, b) = ([round(half[5][0]), round(half[5][1])], [round(half[6][0]), round(half[6][1])]);
                let zc = (b[0] * b[0] + b[1] * b[1] - a[0] * a[0] - a[1] * a[1]) / (2.0 * (b[1] - a[1]));
                let ids: Vec<String> = half.iter().map(|p| sk.pt(*p)).collect();
                let centre = sk.pt_exact([0.0, zc]);
                for i in 0..ids.len() {
                    let (p, q) = (&ids[i], &ids[(i + 1) % ids.len()]);
                    if i == 5 { sk.curve(json!({ "type": "arc", "center": centre, "start": p, "end": q })); } else { sk.curve(json!({ "type": "line", "a": p, "b": q })); }
                }
            } else {
                sk.poly(&half);
            }
            st.turned("Screw", sk, "new");
            st.socket(top, key, depth);
            loops.push(mirrored(&half));
        }
        Kind::Hex => {
            let t = spec.thread.expect("thread");
            let (d, s, k) = (t.dia(), t.mm(t.hex[0]), t.mm(t.hex[1]));
            let c = (d * 0.08).min(t.pitch_mm());
            let mut head = Sk::default();
            head.poly(&hexagon(s));
            st.sketch("head-sketch", "Head outline", json!({ "kind": "plane", "plane": "top" }), head);
            st.extrude("body", "Head", "head-sketch", "new", k, false);
            let half = vec![[0.0, -len], [d / 2.0 - c, -len], [d / 2.0, -len + c], [d / 2.0, 0.0], [0.0, 0.0]];
            let mut sk = Sk::default();
            sk.poly(&half);
            st.turned("Shank", sk, "add");
            let r = s / 3f64.sqrt();
            loops.push(mirrored(&[[0.0, -len], [d / 2.0 - c, -len], [d / 2.0, -len + c], [d / 2.0, 0.0], [r, 0.0], [r, k], [0.0, k]]));
        }
        Kind::Nut | Kind::Standoff => {
            let t = spec.thread.expect("thread");
            let across = if t.nut[0] > 0.0 && spec.kind == Kind::Nut { t.nut[0] } else if t.hex[0] > 0.0 { t.hex[0] } else { t.nut[0] };
            let (s, h) = (t.mm(across), if spec.kind == Kind::Nut { t.mm(t.nut[1]) } else { len });
            let bore = t.dia() - t.pitch_mm();   // the tap drill: the thread is not cut
            let mut sk = Sk::default();
            sk.poly(&hexagon(s));
            st.sketch("outline", "Outline", json!({ "kind": "plane", "plane": "top" }), sk);
            st.extrude("body", if spec.kind == Kind::Nut { "Nut" } else { "Standoff" }, "outline", "new", h, false);
            let mut hole = Sk::default();
            hole.circle([0.0, 0.0], bore / 2.0);
            st.sketch("hole-sketch", "Hole outline", json!({ "kind": "plane", "plane": "top" }), hole);
            st.extrude("hole", "Hole", "hole-sketch", "remove", h, false);
            loops.push(hexagon(s));
            loops.push(circle_loop([0.0, 0.0], bore / 2.0));
        }
        Kind::Washer | Kind::Linear => {
            let (ri, ro, h) = match spec.kind {
                Kind::Washer => { let t = spec.thread.expect("thread"); (t.mm(t.washer[0]) / 2.0, t.mm(t.washer[1]) / 2.0, t.mm(t.washer[2])) }
                _ => { let b = spec.bearing(); (b[0] / 2.0, b[1] / 2.0, b[2]) }
            };
            let mut sk = Sk::default();
            if spec.kind == Kind::Linear {
                let c = 0.5f64.min((ro - ri) * 0.2);
                sk.poly(&[[ri, 0.0], [ro - c, 0.0], [ro, c], [ro, h - c], [ro - c, h], [ri, h]]);
            } else {
                sk.poly(&[[ri, 0.0], [ro, 0.0], [ro, h], [ri, h]]);
            }
            st.turned(if spec.kind == Kind::Washer { "Washer" } else { "Bushing" }, sk, "new");
            loops.push(circle_loop([0.0, 0.0], ro));
            loops.push(circle_loop([0.0, 0.0], ri));
        }
        Kind::Dowel => {
            let r = spec.size / 2.0;
            let c = spec.size * 0.08;
            let half = vec![[0.0, 0.0], [r - c, 0.0], [r, c], [r, len - c], [r - c, len], [0.0, len]];
            let mut sk = Sk::default();
            sk.poly(&half);
            st.turned("Pin", sk, "new");
            loops.push(mirrored(&half));
        }
        Kind::Bearing => {
            let [d, big, b] = spec.bearing();
            let (ri, ro) = (d / 2.0, big / 2.0);
            let wall = (ro - ri) * 0.28;                    // each ring's thickness
            let (r1, r2) = (ri + wall, ro - wall);          // the shields sit between the rings
            let e = (b * 0.07).min(0.5);                    // how far the shields are set back
            let c = (b * 0.06).min(0.6).min(wall * 0.4);    // the rings' chamfers
            let mut sk = Sk::default();
            sk.poly(&[
                [ri + c, 0.0], [r1, 0.0], [r1, e], [r2, e], [r2, 0.0], [ro - c, 0.0], [ro, c], [ro, b - c], [ro - c, b],
                [r2, b], [r2, b - e], [r1, b - e], [r1, b], [ri + c, b], [ri, b - c], [ri, c],
            ]);
            st.turned("Bearing", sk, "new");
            for r in [ro, r2, r1, ri] { loops.push(circle_loop([0.0, 0.0], r)); }
        }
        Kind::TSlot => {
            let side = spec.size;
            let [w, wide, lip, straight, depth, bore] = TSLOTS.iter().find(|(s, _)| *s as f64 == side).map(|(_, v)| *v).unwrap_or(TSLOTS[0].1);
            let h = side / 2.0;
            let (y1, yb) = (h - lip - straight, h - depth);
            let xb = wide / 2.0 - (y1 - yb);                // the slot narrows at 45° to its floor
            // one slot, on the top side, drawn from its right edge to its left; the other three are this one turned
            let slot: [P; 10] = [[w / 2.0, h], [w / 2.0, h - lip], [wide / 2.0, h - lip], [wide / 2.0, y1], [xb, yb], [-xb, yb], [-wide / 2.0, y1], [-wide / 2.0, h - lip], [-w / 2.0, h - lip], [-w / 2.0, h]];
            let mut outline: Vec<P> = Vec::new();
            for q in 0..4 {
                // counter-clockwise from the top right corner: top side, then left, bottom, right
                let turn = |p: P| -> P { match q { 0 => p, 1 => [-p[1], p[0]], 2 => [-p[0], -p[1]], _ => [p[1], -p[0]] } };
                outline.push(turn([h, h]));
                outline.extend(slot.iter().map(|p| turn(*p)));
            }
            let mut sk = Sk::default();
            sk.poly(&outline);
            st.sketch("outline", "Profile", json!({ "kind": "plane", "plane": "top" }), sk);
            st.extrude("body", "Extrusion", "outline", "new", len, false);
            let mut hole = Sk::default();
            hole.circle([0.0, 0.0], bore / 2.0);
            st.sketch("hole-sketch", "Bore outline", json!({ "kind": "plane", "plane": "top" }), hole);
            st.extrude("hole", "Bore", "hole-sketch", "remove", len, false);
            loops.push(outline);
            loops.push(circle_loop([0.0, 0.0], bore / 2.0));
        }
    }
    Drawn { studio: st, loops }
}

/// JSON with every object's keys sorted, as an item document writes its items.
fn sorted(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 { out.push(','); }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                sorted(&m[*k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() { if i > 0 { out.push(','); } sorted(x, out); }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// The part as a part studio (the text of a `.jpart`).
pub fn part_studio(spec: &Spec) -> String {
    let drawn = draw(spec);
    let mut items: Vec<Value> = drawn.studio.features;
    items.push(json!({ "id": "studio", "type": "studio", "units": if spec.thread.is_some_and(|t| t.inch()) { "in" } else { "mm" }, "rollback": null }));
    items.push(json!({
        "id": "standard-part", "type": "standard-part", "spec": spec.id(), "title": spec.part_number(),
        "description": spec.description(), "link": "",
        "note": spec.note(),
    }));
    items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut out = String::from("{\"junction\":\"part-studio\",\"version\":1,\"items\":[\n");
    for (i, it) in items.iter().enumerate() {
        if i > 0 { out.push_str(",\n"); }
        sorted(it, &mut out);
    }
    out.push_str("\n]}\n");
    out
}

/// The part's outline as an SVG path in a box of its own: `{ d, box: [x, y, w, h] }`, y down.
pub fn thumbnail(spec: &Spec) -> Value {
    let loops = draw(spec).loops;
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in loops.iter().flatten() { x0 = x0.min(p[0]); x1 = x1.max(p[0]); y0 = y0.min(-p[1]); y1 = y1.max(-p[1]); }
    let r = |v: f64| (v * 100.0).round() / 100.0;
    let mut d = String::new();
    for l in &loops {
        for (i, p) in l.iter().enumerate() { d.push_str(&format!("{}{} {}", if i == 0 { "M" } else { "L" }, r(p[0]), r(-p[1]))); }
        d.push('Z');
    }
    json!({ "d": d, "box": [r(x0), r(y0), r(x1 - x0), r(y1 - y0)] })
}

/// The size of the part's bounding box, millimetres: across (x and y) and along the axis (z).
pub fn extent(spec: &Spec) -> [f64; 3] { exact_extent(spec).map(|v| (v * 1000.0).round() / 1000.0) }

fn exact_extent(spec: &Spec) -> [f64; 3] {
    let len = spec.length;
    match spec.kind {
        Kind::Bearing | Kind::Linear => { let b = spec.bearing(); [b[1], b[1], b[2]] }
        Kind::TSlot => [spec.size, spec.size, len],
        Kind::Dowel => [spec.size, spec.size, len],
        k => {
            let t = spec.thread.expect("thread");
            let d = t.dia();
            let corners = |s: f64| s * 2.0 / 3f64.sqrt();
            match k {
                Kind::Shcs => [t.mm(t.shcs[0]), t.mm(t.shcs[0]), len + d],
                Kind::Button => [t.mm(t.button[0]), t.mm(t.button[0]), len + t.mm(t.button[1])],
                Kind::Flat => [t.mm(t.flat[0]), t.mm(t.flat[0]), len],
                Kind::Set => [d, d, len],
                Kind::Hex => [corners(t.mm(t.hex[0])), t.mm(t.hex[0]), len + t.mm(t.hex[1])],
                Kind::Nut => [corners(t.mm(t.nut[0])), t.mm(t.nut[0]), t.mm(t.nut[1])],
                Kind::Standoff => { let s = t.mm(if t.hex[0] > 0.0 { t.hex[0] } else { t.nut[0] }); [corners(s), s, len] }
                _ => [t.mm(t.washer[1]), t.mm(t.washer[1]), t.mm(t.washer[2])],
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(q: &str) -> Vec<String> { search(q, 12).iter().map(Spec::id).collect() }

    #[test]
    fn reads_metric_screws() {
        assert_eq!(ids("M5x20 socket head"), ["shcs:M5:20"]);
        assert_eq!(ids("DIN 912 M5x20"), ["shcs:M5:20"]);
        assert_eq!(ids("din912 m5 x 20"), ["shcs:M5:20"]);
        assert_eq!(ids("ISO 4762 M3×8"), ["shcs:M3:8"]);
        assert_eq!(ids("m6x1x30 button head"), ["button:M6:30"]);
        assert_eq!(ids("M4 x 0.7 x 12mm countersunk"), ["flat:M4:12"]);
        assert_eq!(ids("hex bolt M8x40"), ["hex:M8:40"]);
        assert_eq!(ids("M3x4 grub screw"), ["set:M3:4"]);
        // a size and a length without a kind: every screw of that size
        assert_eq!(ids("M5x20"), ["shcs:M5:20", "button:M5:20", "flat:M5:20", "hex:M5:20", "set:M5:20"]);
        // a thread alone: what goes on it, and the socket head in its usual lengths
        assert_eq!(ids("M5")[..2], ["nut:M5", "washer:M5"]);
        assert!(ids("M5").contains(&"shcs:M5:10".to_string()));
        // "x 0.8" after M5 is the pitch
        assert_eq!(ids("M5x0.8 nut"), ["nut:M5"]);
        assert_eq!(ids("M5 washer"), ["washer:M5"]);
        assert_eq!(ids("DIN 934 M8"), ["nut:M8"]);
        // sizes the standard does not have
        assert!(ids("M7x20 socket head").is_empty());
        assert!(ids("M2x6 button head").is_empty());
        assert_eq!(ids("M5x12 button head cap screw"), ["button:M5:12"]);
        assert_eq!(ids("M8x30 hex cap screw"), ["hex:M8:30"]);
        assert!(ids("resistor 10k").is_empty());
        assert!(ids("C8734").is_empty());
    }

    #[test]
    fn reads_inch_screws() {
        assert_eq!(ids("1/4-20 x 1 socket head"), ["shcs:1/4:1in"]);
        assert_eq!(ids("1/4\"-20 x 1-3/4\" socket head cap screw"), ["shcs:1/4:1.75in"]);
        assert_eq!(ids("1/4-28 x 1 3/4 shcs"), ["shcs:1/4-28:1.75in"]);
        assert_eq!(ids("#8-32 x 1/2 button head"), ["button:#8:0.5in"]);
        assert_eq!(ids("10-32x3/4 flat head"), ["flat:#10-32:0.75in"]);
        assert_eq!(ids("1/4-20 nut"), ["nut:1/4"]);
        let s = Spec::from_id("shcs:1/4:1.75in").unwrap();
        assert_eq!(s.part_number(), "ASME B18.3 SHCS 1/4-20 x 1-3/4");
        assert_eq!(s.description(), "Socket head cap screw 1/4\"-20 × 1-3/4\" (ASME B18.3)");
        assert!((extent(&s)[2] - (1.75 + 0.25) * 25.4).abs() < 1e-3);
    }

    #[test]
    fn reads_other_parts() {
        assert_eq!(ids("608 bearing"), ["bearing:608"]);
        assert_eq!(ids("608zz"), ["bearing:608"]);
        assert_eq!(ids("6204-2RS"), ["bearing:6204"]);
        assert_eq!(ids("LM8UU"), ["linear:LM8UU"]);
        assert_eq!(ids("2020 extrusion 300"), ["tslot:20:300"]);
        assert_eq!(ids("20x20 t-slot 250mm"), ["tslot:20:250"]);
        assert_eq!(ids("3030 extrusion").len(), 4);
        assert_eq!(ids("dowel pin 5x20"), ["dowel:5:20"]);
        assert_eq!(ids("M3x10 standoff"), ["standoff:M3:10"]);
        assert_eq!(Spec::from_id("bearing:608").unwrap().description(), "Deep-groove ball bearing 608: 8 × 22 × 7 mm (ISO 15)");
    }

    #[test]
    fn ids_round_trip_and_bad_ones_are_refused() {
        for q in ["M5x20", "1/4-20 x 1", "#10-32 x 3/4 socket head", "M5", "608", "2020 extrusion", "dowel 6 x 30", "M4x20 standoff", "LM10UU"] {
            for s in search(q, 20) {
                let back = Spec::from_id(&s.id()).unwrap_or_else(|| panic!("{} does not read back", s.id()));
                assert_eq!(back.id(), s.id());
                assert_eq!(back.part_number(), s.part_number());
            }
        }
        for bad in ["", "shcs", "shcs:M5", "shcs:M7:20", "shcs:M5:0", "shcs:M5:-3", "shcs:M5:20:1", "nut:M5:3", "bearing:999", "tslot:25:100", "widget:M5:20", "shcs:1/4-99:1in", "flat:M5:2"] {
            assert!(Spec::from_id(bad).is_none(), "{bad} was taken");
        }
    }

    #[test]
    fn names_and_sizes() {
        let s = Spec::from_id("shcs:M5:20").unwrap();
        assert_eq!(s.part_number(), "ISO 4762 M5x20");
        assert_eq!(s.description(), "Socket head cap screw M5 × 20 mm (ISO 4762 / DIN 912)");
        assert_eq!(extent(&s), [8.5, 8.5, 25.0]);
        assert_eq!(extent(&Spec::from_id("nut:M5").unwrap())[1..], [8.0, 4.7]);
        assert_eq!(extent(&Spec::from_id("washer:M5").unwrap()), [10.0, 10.0, 1.0]);
        assert_eq!(Spec::from_id("tslot:20:300").unwrap().part_number(), "T-slot 2020 x 300");
        assert_eq!(inch_text(44.45), "1-3/4");
        assert_eq!(inch_text(25.4), "1");
        assert_eq!(inch_text(9.525), "3/8");
    }

    #[test]
    fn writes_a_part_studio() {
        let s = Spec::from_id("shcs:M5:20").unwrap();
        let text = part_studio(&s);
        let v: Value = serde_json::from_str(&text).expect("the part studio is JSON");
        assert_eq!(v["junction"], "part-studio");
        let items = v["items"].as_array().unwrap();
        let kinds: Vec<&str> = items.iter().filter(|i| i["type"] == "feature").map(|i| i["featureType"].as_str().unwrap()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "sketch").count(), 2);
        assert!(kinds.contains(&"revolve") && kinds.contains(&"extrude") && kinds.contains(&"plane"));
        // one item per line, in id order
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), items.len() + 2);
        let ids: Vec<&str> = items.iter().map(|i| i["id"].as_str().unwrap()).collect();
        let mut want = ids.clone();
        want.sort();
        assert_eq!(ids, want);
        // every screw's profile closes on the axis: the first and last points have x = 0
        let t = thumbnail(&s);
        assert!(t["d"].as_str().unwrap().starts_with('M'));
        assert_eq!(t["box"], json!([-4.25, -5.0, 8.5, 25.0]));
        // every kind draws
        for id in ["button:M5:12", "flat:M5:16", "hex:M8:40", "set:M4:6", "nut:M6", "washer:M6", "dowel:5:20", "standoff:M3:10", "bearing:608", "linear:LM8UU", "tslot:20:100", "shcs:#8:0.5in", "flat:1/4:1in"] {
            let s = Spec::from_id(id).unwrap_or_else(|| panic!("{id}"));
            let text = part_studio(&s);
            assert!(serde_json::from_str::<Value>(&text).is_ok(), "{id}");
            assert!(!thumbnail(&s)["d"].as_str().unwrap().is_empty());
        }
    }

    /// The part studios the kernel test builds (static/tests/models3d.test.js).  They are written out
    /// with `MODELS3D_WRITE_FIXTURES=1 cargo test fixtures_are_current` and compared otherwise, so the
    /// kernel test always builds what this file writes.
    #[test]
    fn fixtures_are_current() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("static/tests/fixtures/models3d");
        let cases = ["shcs:M5:20", "button:M5:12", "flat:M5:16", "hex:M8:40", "set:M4:6", "nut:M6", "washer:M6", "dowel:5:20", "standoff:M3:10", "bearing:608", "linear:LM8UU", "tslot:20:100", "shcs:1/4:1in", "flat:1/4:1in"];
        let mut index = Vec::new();
        for id in cases {
            let s = Spec::from_id(id).unwrap();
            let file = format!("{}.jpart", id.replace([':', '/', '#'], "_"));
            let text = part_studio(&s);
            index.push(json!({ "id": id, "file": file, "extent": extent(&s), "name": s.part_number() }));
            let path = dir.join(&file);
            if std::env::var("MODELS3D_WRITE_FIXTURES").is_ok() { std::fs::create_dir_all(&dir).unwrap(); std::fs::write(&path, &text).unwrap(); }
            else { assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text, "{file} is stale: run MODELS3D_WRITE_FIXTURES=1 cargo test fixtures_are_current"); }
        }
        let text = serde_json::to_string_pretty(&Value::Array(index)).unwrap() + "\n";
        let path = dir.join("index.json");
        if std::env::var("MODELS3D_WRITE_FIXTURES").is_ok() { std::fs::write(&path, &text).unwrap(); } else { assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text, "index.json is stale"); }
    }
}
