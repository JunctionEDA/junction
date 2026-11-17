//! A vendor's STEP model moved so that the (model …) entry Junction writes for it places it as EasyEDA does.
//!
//! EasyEDA puts a part's 3D model by its bounding box, not by the file's own origin: the box is centred in X and Y
//! and stood on Z = 0, then moved by the 3D outline's c_origin and z and turned by its c_rotation.  The footprints
//! Junction converts carry that move and turn as their (model (offset …) (rotate …)) — `Model3d::offset` is
//! (x, y, -z), Y up, as KiCad writes it.  KiCad reads such an entry as R · p + offset on the file as it is, so the
//! file served is moved by
//!
//! ```text
//!     T = (x, y, z) - (box centre x, box centre y, box bottom) - R⁻¹ · offset
//! ```
//!
//! which makes KiCad's R · (p + T) + offset equal EasyEDA's R · (p - box + (x, y, z)), in every viewer and exporter
//! that reads the file: the web viewer, the desktop app and stock KiCad with a downloaded library alike.
//!
//! Moving every CARTESIAN_POINT by the same T moves the whole model by T, also through an assembly's placements
//! (each ITEM_DEFINED_TRANSFORMATION maps one placement onto another, both moved by T, so the move passes through it
//! once).  The box is the box of the points: exact at the vertices that bound most parts, a little short of a round
//! face that bulges past its edges' vertices.

/// Length unit of the file: millimetres per file unit.
fn unit_mm(text: &str) -> f64 {
    let up = text.to_ascii_uppercase();
    if up.contains("'INCH'") {
        25.4
    } else if up.contains(".MILLI.,.METRE.") || up.contains(".MILLI., .METRE.") {
        1.0
    } else if up.contains(".CENTI.,.METRE.") {
        10.0
    } else if up.contains("SI_UNIT($,.METRE.)") || up.contains("SI_UNIT( $, .METRE. )") {
        1000.0
    } else {
        1.0
    }
}

/// Every 3D CARTESIAN_POINT's coordinate list as a byte range of the text, with its numbers.
fn points(text: &str) -> Vec<(std::ops::Range<usize>, [f64; 3])> {
    triples(text, "CARTESIAN_POINT")
}

/// Every 3D `key` entity's (… , (x, y, z)) list as a byte range of the text, with its numbers.
fn triples(text: &str, key: &str) -> Vec<(std::ops::Range<usize>, [f64; 3])> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut from = 0;
    while let Some(i) = text[from..].find(key) {
        let at = from + i + key.len();
        from = at;
        // CARTESIAN_POINT ( 'name' , ( x , y , z ) )
        let mut j = at;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= b.len() || b[j] != b'(' {
            continue;
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < b.len() && b[j] == b'\'' {
            j += 1;
            // a quote inside a STEP string is written twice
            while j < b.len() {
                if b[j] == b'\'' {
                    if j + 1 < b.len() && b[j + 1] == b'\'' {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            j += 1;
        }
        let Some(open) = text[j..].find('(').map(|k| j + k) else { continue };
        let Some(close) = text[open..].find(')').map(|k| open + k) else { continue };
        let nums: Vec<f64> = text[open + 1..close].split(',').filter_map(|s| s.trim().parse::<f64>().ok()).collect();
        if nums.len() == 3 && text[open + 1..close].split(',').count() == 3 {
            out.push((open + 1..close, [nums[0], nums[1], nums[2]]));
        }
        from = close;
    }
    out
}

/// KiCad's model rotation (3d-viewer: rotateZ(-rz) · rotateY(-ry) · rotateX(-rx)) applied to `v`; `inverse` undoes it.
fn turn(v: [f64; 3], rot: [f64; 3], inverse: bool) -> [f64; 3] {
    let r = |a: f64| (-a).to_radians();
    let (rx, ry, rz) = (r(rot[0]), r(rot[1]), r(rot[2]));
    let about_x = |v: [f64; 3], a: f64| [v[0], v[1] * a.cos() - v[2] * a.sin(), v[1] * a.sin() + v[2] * a.cos()];
    let about_y = |v: [f64; 3], a: f64| [v[0] * a.cos() + v[2] * a.sin(), v[1], -v[0] * a.sin() + v[2] * a.cos()];
    let about_z = |v: [f64; 3], a: f64| [v[0] * a.cos() - v[1] * a.sin(), v[0] * a.sin() + v[1] * a.cos(), v[2]];
    if inverse {
        about_x(about_y(about_z(v, -rz), -ry), -rx)
    } else {
        about_z(about_y(about_x(v, rx), ry), rz)
    }
}

/// The move T (millimetres) for a model with these points, offset and rotate; None when the file has no 3D point.
pub fn fit_move(text: &str, offset: [f64; 3], rotate: [f64; 3]) -> Option<[f64; 3]> {
    let k = unit_mm(text);
    let pts = points(text);
    if pts.is_empty() {
        return None;
    }
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for (_, p) in &pts {
        for a in 0..3 {
            lo[a] = lo[a].min(p[a] * k);
            hi[a] = hi[a].max(p[a] * k);
        }
    }
    let back = turn(offset, rotate, true);
    let target = [offset[0], offset[1], -offset[2]];
    let box_at = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, lo[2]];
    Some([0, 1, 2].map(|a| target[a] - box_at[a] - back[a]))
}

/// The file with every 3D point moved by `t` millimetres.
pub fn moved(text: &str, t: [f64; 3]) -> String {
    let k = unit_mm(text);
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut last = 0;
    for (range, p) in points(text) {
        out.push_str(&text[last..range.start]);
        let n = [0, 1, 2].map(|a| p[a] + t[a] / k);
        out.push_str(&format!("{},{},{}", real(n[0]), real(n[1]), real(n[2])));
        last = range.end;
    }
    out.push_str(&text[last..]);
    out
}

/// The file turned by KiCad's model rotation `rotate` and then moved by `t` millimetres: every point and direction,
/// which turns and moves the whole model, through an assembly's placements too.
pub fn transformed(text: &str, rotate: [f64; 3], t: [f64; 3]) -> String {
    let k = unit_mm(text);
    let mut edits: Vec<(std::ops::Range<usize>, [f64; 3])> = Vec::new();
    for (range, p) in points(text) {
        let r = turn(p, rotate, false);
        edits.push((range, [0, 1, 2].map(|a| r[a] + t[a] / k)));
    }
    for (range, d) in triples(text, "DIRECTION") {
        edits.push((range, turn(d, rotate, false)));
    }
    edits.sort_by_key(|(r, _)| r.start);
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut last = 0;
    for (range, n) in edits {
        out.push_str(&text[last..range.start]);
        out.push_str(&format!("{},{},{}", real(n[0]), real(n[1]), real(n[2])));
        last = range.end;
    }
    out.push_str(&text[last..]);
    out
}

/// The vendor's file placed as EasyEDA places it on its footprint, for an entry with no offset or turn of its own
/// (easyeda2kicad's .wrl, whose own copy has the move built in): the lined-up file with the vendor's turn and offset.
pub fn placed(bytes: &[u8], offset: [f64; 3], rotate: [f64; 3]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else { return bytes.to_vec() };
    let Some(t) = fit_move(text, offset, rotate) else { return bytes.to_vec() };
    transformed(&moved(text, t), rotate, offset).into_bytes()
}

/// A STEP REAL: always with a decimal point.
fn real(v: f64) -> String {
    let s = format!("{:.6}", if v.abs() < 5e-7 { 0.0 } else { v });
    let s = s.trim_end_matches('0');
    if s.ends_with('.') { format!("{s}0") } else { s.to_string() }
}

/// The vendor's STEP file lined up for its (model …) entry; the file as it is when it cannot be read as text.
pub fn fitted(bytes: &[u8], offset: [f64; 3], rotate: [f64; 3]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else { return bytes.to_vec() };
    match fit_move(text, offset, rotate) {
        Some(t) => moved(text, t).into_bytes(),
        None => bytes.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: &str = "ISO-10303-21;\nDATA;\n#1=SI_UNIT(.MILLI.,.METRE.);\n#2=CARTESIAN_POINT('',(-7.75,-13.5,-3.87));\n#3=CARTESIAN_POINT('it''s',(7.75,0.5,7.64));\n#4=CARTESIAN_POINT('',(3.5,-0.25,-3.87));\n#5=CARTESIAN_POINT('',(1.,2.));\nENDSEC;\n";

    fn pts(text: &str) -> Vec<[f64; 3]> {
        points(text).into_iter().map(|(_, p)| p).collect()
    }

    #[test]
    fn usb_a_leads_land_on_their_pads() {
        // LCSC C456018: EasyEDA's offset 0,-4.9,3.8; KiCad then adds the same offset
        let out = String::from_utf8(fitted(BOX.as_bytes(), [0.0, -4.9, 3.8], [0.0; 3])).unwrap();
        let p = pts(&out);
        assert_eq!(p.len(), 3, "the 2D point is left alone");
        let lead = [p[2][0], p[2][1] - 4.9, p[2][2] + 3.8];
        for (a, want) in [3.5, 1.35, -3.8].iter().enumerate() {
            assert!((lead[a] - want).abs() < 1e-4, "{a}: {lead:?}");
        }
        assert!(out.contains("CARTESIAN_POINT('it''s',("), "names are kept");
        assert!(out.contains("(1.,2.)"));
    }

    #[test]
    fn turned_model() {
        let out = String::from_utf8(fitted(BOX.as_bytes(), [0.0, -4.9, 3.8], [0.0, 0.0, 90.0])).unwrap();
        let p = pts(&out)[2];
        // KiCad: rotateZ(-90°) then the offset
        let r = turn(p, [0.0, 0.0, 90.0], false);
        let at = [r[0], r[1] - 4.9, r[2] + 3.8];
        // EasyEDA: the box moved, then turned
        let want = turn([3.5, 1.35, -3.8], [0.0, 0.0, 90.0], false);
        for a in 0..3 {
            assert!((at[a] - want[a]).abs() < 1e-4, "{a}: {at:?} vs {want:?}");
        }
    }

    #[test]
    fn placed_for_an_entry_without_offset() {
        let text = format!("{BOX}#6=DIRECTION('',(1.,0.,0.));\n");
        let out = String::from_utf8(placed(text.as_bytes(), [0.0, -4.9, 3.8], [0.0, 0.0, 90.0])).unwrap();
        let p = pts(&out)[2];
        let want = turn([3.5, 1.35, -3.8], [0.0, 0.0, 90.0], false);
        for a in 0..3 {
            assert!((p[a] - want[a]).abs() < 1e-4, "{a}: {p:?} vs {want:?}");
        }
        let d = triples(&out, "DIRECTION")[0].1;
        assert!((d[0]).abs() < 1e-9 && (d[1] + 1.0).abs() < 1e-9, "directions turn with the model: {d:?}");
    }

    #[test]
    fn inch_files_move_in_inches() {
        let inch = BOX.replace("#1=SI_UNIT(.MILLI.,.METRE.);", "#1=CONVERSION_BASED_UNIT('INCH',#9);");
        let t = fit_move(&inch, [0.0; 3], [0.0; 3]).unwrap();
        assert!((t[2] - 3.87 * 25.4).abs() < 1e-6);
        let p = pts(&moved(&inch, t))[0];
        assert!((p[2] * 25.4).abs() < 1e-4, "the box stands on 0: {p:?}");
    }

    #[test]
    fn reals_have_a_point() {
        assert_eq!(real(2.0), "2.0");
        assert_eq!(real(-0.0000001), "0.0");
        assert_eq!(real(1.25), "1.25");
    }
}
