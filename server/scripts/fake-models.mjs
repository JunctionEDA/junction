// fake-models.mjs — stand-ins for the suppliers of 3D models (server/src/models3d), mounted by fake-vendors.mjs.
//
// NOTHING here is a recorded answer.  The network these tests run on reaches none of the real services, and
// McMaster-Carr and TraceParts answer nobody without an account, so every shape below is written by hand from
// the provider's code and what each service documents.  They prove the providers' requests, parsing, caching and
// error handling against that reading; they do not prove the reading against the live services.
//
//   McMaster-Carr   POST /v1/login, PUT /v1/products, GET /v1/products/{number}, GET /v1/cad/…, GET /v1/images/…
//   FreeCAD library GET /repos/FreeCAD/FreeCAD-library/git/trees/master?recursive=1 (GitHub's tree API),
//                   GET /FreeCAD/FreeCAD-library/master/{path} (raw files)
//   KiCad library   GET /api/v4/projects/kicad%2Flibraries%2Fkicad-packages3D/repository/tree (GitLab's tree API),
//                   GET /kicad/libraries/kicad-packages3D/-/raw/master/{lib}.3dshapes/{name}.step
//   TraceParts      POST /v2/RequestToken, GET /v3/Search/ProductList, POST /v3/Product/cadRequest,
//                   GET /v2/Product/cadFileUrl, GET /traceparts-files/{id}.stp
//   a library       GET /library/index.json, GET /library/{file}
//
// Point the server at them (PORT is fake-vendors', 8097 by default):
//   MCMASTER_API_URL=http://127.0.0.1:8097 MCMASTER_USERNAME=test-mcmaster MCMASTER_PASSWORD=test-mcmaster-password
//   FREECAD_LIBRARY_API_URL=http://127.0.0.1:8097 FREECAD_LIBRARY_RAW_URL=http://127.0.0.1:8097
//   KICAD_LIBS_URL=http://127.0.0.1:8097
//   TRACEPARTS_API_URL=http://127.0.0.1:8097 TRACEPARTS_TENANT_UID=test-tenant TRACEPARTS_API_KEY=test-traceparts-key TRACEPARTS_USER_EMAIL=cad@example.com
//   MODELS3D_LIBRARY_URL=http://127.0.0.1:8097/library
// Leave the credentials out to see a provider as "not connected".
//
// The models are STEP files written here: a box of the part's overall size, named after the part.  They are real
// STEP (AP214, one MANIFOLD_SOLID_BREP of flat faces), so the kernel reads them as it reads a supplier's file.

export const MCMASTER_USER = 'test-mcmaster', MCMASTER_PASSWORD = 'test-mcmaster-password', MCMASTER_TOKEN = 'mcm-token-1';
export const TRACEPARTS_TENANT = 'test-tenant', TRACEPARTS_KEY = 'test-traceparts-key', TRACEPARTS_TOKEN = 'tp-token-1';

const num = (v) => { const s = (Math.abs(v) < 5e-10 ? 0 : v).toFixed(6).replace(/0+$/, ''); return s.endsWith('.') ? s + '0' : s; };

/** A STEP file of one box, `size` millimetres, its corner at the origin. */
export function stepBox(name, [w, d, h]) {
  const out = []; let n = 0;
  const put = (e) => { out.push(`#${++n}=${e};`); return n; };
  const q = String(name).replace(/[^\x20-\x7e]/g, '').replace(/'/g, "''");
  const app = put("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  put(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const pctx = put(`PRODUCT_CONTEXT('',#${app},'mechanical')`), pdctx = put(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const prod = put(`PRODUCT('${q}','${q}','',(#${pctx}))`);
  put(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const pdf = put(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`), pd = put(`PRODUCT_DEFINITION('design','',#${pdf},#${pdctx})`), pds = put(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  const mm = put('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))'), rad = put('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))'), sr = put('(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())');
  const unc = put(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${mm},'distance_accuracy_value','confusion accuracy')`);
  const ctx = put(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const o = put("CARTESIAN_POINT('',(0.,0.,0.))"), z = put("DIRECTION('',(0.,0.,1.))"), x = put("DIRECTION('',(1.,0.,0.))");
  const axis = put(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${x})`);
  const verts = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  // each face counter-clockwise seen from outside, with its outward normal
  const faces = [[[0, 3, 2, 1], [0, 0, -1]], [[4, 5, 6, 7], [0, 0, 1]], [[0, 1, 5, 4], [0, -1, 0]], [[1, 2, 6, 5], [1, 0, 0]], [[2, 3, 7, 6], [0, 1, 0]], [[3, 0, 4, 7], [-1, 0, 0]]];
  const pts = verts.map((p) => put(`CARTESIAN_POINT('',(${p.map(num).join(',')}))`));
  const vps = pts.map((p) => put(`VERTEX_POINT('',#${p})`));
  const edges = new Map();
  const made = faces.map(([f, nrm]) => {
    const oes = f.map((a, i) => {
      const b = f[(i + 1) % f.length], lo = Math.min(a, b), hi = Math.max(a, b), key = lo + ':' + hi;
      if (!edges.has(key)) {
        const p = verts[lo], r = verts[hi], dv = [r[0] - p[0], r[1] - p[1], r[2] - p[2]], len = Math.hypot(...dv);
        const dir = put(`DIRECTION('',(${dv.map((v) => num(v / len)).join(',')}))`), vec = put(`VECTOR('',#${dir},${num(len)})`), line = put(`LINE('',#${pts[lo]},#${vec})`);
        edges.set(key, put(`EDGE_CURVE('',#${vps[lo]},#${vps[hi]},#${line},.T.)`));
      }
      return put(`ORIENTED_EDGE('',*,*,#${edges.get(key)},${a < b ? '.T.' : '.F.'})`);
    });
    const loop = put(`EDGE_LOOP('',(${oes.map((i) => '#' + i).join(',')}))`), bound = put(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    const a = verts[f[0]], b = verts[f[1]], e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], el = Math.hypot(...e);
    const nd = put(`DIRECTION('',(${nrm.map(num).join(',')}))`), xd = put(`DIRECTION('',(${e.map((v) => num(v / el)).join(',')}))`);
    const plane = put(`PLANE('',#${put(`AXIS2_PLACEMENT_3D('',#${pts[f[0]]},#${nd},#${xd})`)})`);
    return put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
  });
  const shell = put(`CLOSED_SHELL('',(${made.map((i) => '#' + i).join(',')}))`), brep = put(`MANIFOLD_SOLID_BREP('${q}',#${shell})`);
  const rep = put(`ADVANCED_BREP_SHAPE_REPRESENTATION('${q}',(#${axis},#${brep}),#${ctx})`);
  put(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  return Buffer.from(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('A stand-in model for tests'),'2;1');\nFILE_NAME('${q}.step','2026-01-01T00:00:00',('Junction'),('Junction'),'fake-models.mjs','Junction','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n${out.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`);
}

// ---- McMaster-Carr: what the API says of a few part numbers (descriptions as McMaster words such parts)
const mcmaster = {
  '91251A431': { family: 'Black-Oxide Alloy Steel Socket Head Screw', detail: '1/4"-20 Thread Size, 1" Long', size: [9.5, 9.5, 31.75], cad: true },
  '92196A537': { family: '18-8 Stainless Steel Socket Head Screw', detail: '1/4"-20 Thread Size, 1/2" Long', size: [9.5, 9.5, 19.05], cad: true },
  '6384K365': { family: 'Ball Bearing', detail: 'Shielded, Trade Number R8-2Z, for 1/2" Shaft Diameter', size: [28.6, 28.6, 7.9], cad: true },
  // a part McMaster lists without CAD
  '7122K19': { family: 'Cable Tie', detail: 'Standard, 4" Long', size: [1, 1, 1], cad: false },
};
const subscribed = new Set();

// ---- the FreeCAD parts library: a few of its paths
const freecad = {
  'Mechanical Parts/Fasteners/Metric/Screws/ISO4762 Hexagon socket head cap screw/ISO4762 M5x20.step': [8.5, 8.5, 25],
  'Mechanical Parts/Bearings/Ball bearings/608ZZ.step': [22, 22, 7],
  'Electrical Parts/electronic-components/motors/NEMA17 stepper motor.stp': [42.3, 42.3, 48],
  'Mechanical Parts/Profiles EN/20x20 aluminium profile.fcstd': null,   // not a STEP file: never offered
};
// ---- KiCad's packages3D: a few libraries
const kicad = { Connector_USB: ['USB_C_Receptacle_GCT_USB4085', 'USB_Micro-B_Molex_47346-0001'], Package_SO: ['SOIC-8_3.9x4.9mm_P1.27mm'], MountingHole: ['MountingHole_3.2mm_M3'] };
// ---- TraceParts: two catalogue parts
const traceparts = [
  { partFamilyCode: '10-14012019-089953', partNumber: 'MGN12H-1R300', manufacturerName: 'HIWIN', label: 'Linear guideway MGN12, block H, rail 300 mm', productUrl: 'https://www.traceparts.com/en/product/hiwin-mgn12h', size: [27, 300, 13] },
  { partFamilyCode: '10-02112018-103302', partNumber: 'KP08', manufacturerName: 'ASAHI', label: 'Pillow block bearing unit KP08, bore 8 mm', productUrl: 'https://www.traceparts.com/en/product/asahi-kp08', size: [55, 13, 29] },
];
const requests = new Map();
// ---- a library of one's own
const library = {
  name: 'Acme parts', license: 'Internal use',
  models: [
    { id: 'acme-bracket-40', part_number: 'BR-40', supplier: 'Acme', description: 'Corner bracket 40 mm, anodised', file: 'brackets/BR-40.step', url: 'https://parts.acme.example/BR-40', keywords: 'angle corner' },
    { id: 'acme-knob', part_number: 'KN-6', description: 'Knurled knob M6', file: 'knobs/KN-6.stp' },
    { id: 'acme-escape', part_number: 'XX-1', description: 'A file outside the library: never offered', file: '../secret.step' },
  ],
};
/** Forget what earlier requests left behind (the McMaster subscriptions, the TraceParts requests): POST /__ctl/reset. */
export function resetModels() { subscribed.clear(); requests.clear(); }
const librarySizes = { 'brackets/BR-40.step': [40, 40, 20], 'knobs/KN-6.stp': [25, 25, 18] };

/**
 * Answer a request if it is one of the model suppliers'.  `ctx`: { req, res, url, path, json (the body, parsed),
 * send(res, status, data, type), hit(name), down (who is offline) }.  Returns whether it answered.
 */
export function models3d({ req, res, url, path: p, json: j, send, hit, down }) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');

  // ---- McMaster-Carr
  if (p === '/v1/login') {
    hit('mcmaster-login');
    if (down.mcmaster) { send(res, 503, 'upstream down', 'text/plain'); return true; }
    if (j.UserName !== MCMASTER_USER || j.Password !== MCMASTER_PASSWORD) { send(res, 401, { ErrorCode: 401, ErrorMessage: 'Invalid user name or password', ErrorDescription: '' }); return true; }
    send(res, 200, { TokenType: 'Bearer', AuthToken: MCMASTER_TOKEN, ExpirationTS: '2099-01-01T00:00:00Z' }); return true;
  }
  if (p === '/v1/products' || p.startsWith('/v1/products/') || p.startsWith('/v1/cad/') || p.startsWith('/v1/images/')) {
    hit('mcmaster');
    if (down.mcmaster) { send(res, 503, 'upstream down', 'text/plain'); return true; }
    if (bearer !== MCMASTER_TOKEN) { send(res, 401, { ErrorCode: 401, ErrorMessage: 'Authorization token is missing or expired', ErrorDescription: '' }); return true; }
    if (p === '/v1/products' && req.method === 'PUT') {
      const number = String(j.URL || '').replace(/\/+$/, '').split('/').pop().toUpperCase();
      if (!mcmaster[number]) { send(res, 404, { ErrorCode: 404, ErrorMessage: 'Product not found', ErrorDescription: number }); return true; }
      subscribed.add(number); hit('mcmaster-subscribe'); send(res, 201, { PartNumber: number }); return true;
    }
    let m = /^\/v1\/products\/([0-9A-Z]+)$/.exec(p);
    if (m) {
      const part = mcmaster[m[1]];
      if (!part) { send(res, 404, { ErrorCode: 404, ErrorMessage: 'Product not found', ErrorDescription: m[1] }); return true; }
      // McMaster answers only for products the account has subscribed to
      if (!subscribed.has(m[1])) { send(res, 403, { ErrorCode: 403, ErrorMessage: 'Not subscribed to product', ErrorDescription: m[1] }); return true; }
      send(res, 200, {
        PartNumber: m[1], DetailDescription: part.detail, FamilyDescription: part.family, ProductCategory: 'Fastening & Joining', ProductStatus: 'Active',
        Specifications: [{ Attribute: 'Material', Values: ['Steel'] }],
        Links: [{ Key: 'Price', Value: `/v1/products/${m[1]}/price` }, { Key: 'Image', Value: `/v1/images/${m[1]}.png` },
          ...(part.cad ? [{ Key: '2-D DWG', Value: `/v1/cad/${m[1]}.DWG` }, { Key: '3-D STEP', Value: `/v1/cad/${m[1]}.STEP` }] : [])],
      });
      return true;
    }
    m = /^\/v1\/cad\/([0-9A-Z]+)\.STEP$/.exec(p);
    if (m && mcmaster[m[1]] && mcmaster[m[1]].cad) { hit('mcmaster-cad'); send(res, 200, stepBox(`McMaster-Carr ${m[1]}`, mcmaster[m[1]].size), 'application/octet-stream'); return true; }
    m = /^\/v1\/images\/([0-9A-Z]+)\.png$/.exec(p);
    // a 1 × 1 PNG
    if (m && mcmaster[m[1]]) { send(res, 200, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), 'image/png'); return true; }
    send(res, 404, { ErrorCode: 404, ErrorMessage: 'Not found', ErrorDescription: p }); return true;
  }

  // ---- the FreeCAD parts library, as GitHub serves it
  if (p === '/repos/FreeCAD/FreeCAD-library/git/trees/master') {
    hit('freecad-tree');
    if (down.freecad) { send(res, 503, 'upstream down', 'text/plain'); return true; }
    send(res, 200, { sha: 'f00', truncated: false, tree: [{ path: 'Mechanical Parts', type: 'tree' }, ...Object.keys(freecad).map((path) => ({ path, mode: '100644', type: 'blob', size: 4000 }))] }); return true;
  }
  if (p.startsWith('/FreeCAD/FreeCAD-library/master/')) {
    hit('freecad-file');
    if (down.freecad) { send(res, 503, 'upstream down', 'text/plain'); return true; }
    const file = decodeURIComponent(p.slice('/FreeCAD/FreeCAD-library/master/'.length));
    if (freecad[file]) send(res, 200, stepBox(file.split('/').pop().replace(/\.[^.]+$/, ''), freecad[file]), 'text/plain'); else send(res, 404, '404: Not Found', 'text/plain');
    return true;
  }

  // ---- KiCad's 3D library, as GitLab serves it
  if (p.toLowerCase() === '/api/v4/projects/kicad%2flibraries%2fkicad-packages3d/repository/tree') {
    hit('kicad-tree');
    if (down.kicad) { send(res, 503, 'upstream down', 'text/plain'); return true; }
    const all = Object.entries(kicad).flatMap(([lib, names]) => [{ name: `${lib}.3dshapes`, path: `${lib}.3dshapes`, type: 'tree' }, ...names.flatMap((n) => [{ name: `${n}.step`, path: `${lib}.3dshapes/${n}.step`, type: 'blob' }, { name: `${n}.wrl`, path: `${lib}.3dshapes/${n}.wrl`, type: 'blob' }])]);
    const page = +(url.searchParams.get('page') || 1), per = +(url.searchParams.get('per_page') || 20);
    send(res, 200, all.slice((page - 1) * per, page * per)); return true;
  }
  let m = /^\/kicad\/libraries\/kicad-packages3D\/-\/raw\/[^/]+\/([^/]+)\.3dshapes\/([^/]+)\.step$/.exec(p);
  if (m) {
    hit('kicad-file');
    const [lib, name] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
    if (kicad[lib] && kicad[lib].includes(name)) send(res, 200, stepBox(name, [9, 7.3, 3.2]), 'text/plain'); else send(res, 404, 'not found', 'text/plain');
    return true;
  }

  // ---- TraceParts
  if (p === '/v2/RequestToken') {
    hit('traceparts-token');
    if (j.tenantUid !== TRACEPARTS_TENANT || j.apiKey !== TRACEPARTS_KEY) { send(res, 401, { message: 'Invalid tenantUid or apiKey' }); return true; }
    send(res, 200, { token: TRACEPARTS_TOKEN }); return true;
  }
  if (p === '/v3/Search/ProductList' || p === '/v3/Product/cadRequest' || p === '/v2/Product/cadFileUrl') {
    hit('traceparts');
    if (down.traceparts) { send(res, 503, 'upstream down', 'text/plain'); return true; }
    if (bearer !== TRACEPARTS_TOKEN) { send(res, 401, { message: 'Unauthorized' }); return true; }
    if (p === '/v3/Search/ProductList') {
      const words = (url.searchParams.get('keyword') || '').toLowerCase().split(/\s+/).filter(Boolean);
      const found = traceparts.filter((t) => words.every((w) => `${t.partNumber} ${t.manufacturerName} ${t.label}`.toLowerCase().includes(w)));
      send(res, 200, { totalNumberOfResults: found.length, products: found.map(({ size, ...rest }) => rest) }); return true;
    }
    if (p === '/v3/Product/cadRequest') {
      const part = traceparts.find((t) => t.partFamilyCode === j.partFamilyCode && t.partNumber === j.partNumber);
      if (!part || !j.userEmail || !j.cadFormatId) { send(res, 400, { message: 'Bad request' }); return true; }
      const id = 1000 + requests.size; requests.set(String(id), { part, asked: 0 });
      send(res, 201, { cadRequestId: id }); return true;
    }
    const r = requests.get(url.searchParams.get('cadRequestId') || '');
    if (!r) { send(res, 404, { message: 'Unknown request' }); return true; }
    // the file is not ready the first time it is asked for
    if (r.asked++ === 0) { send(res, 204, ''); return true; }
    send(res, 200, { url: `http://${req.headers.host}/traceparts-files/${encodeURIComponent(r.part.partNumber)}.stp` }); return true;
  }
  m = /^\/traceparts-files\/(.+)\.stp$/.exec(p);
  if (m) {
    const part = traceparts.find((t) => t.partNumber === decodeURIComponent(m[1]));
    if (part) send(res, 200, stepBox(part.partNumber, part.size), 'application/octet-stream'); else send(res, 404, 'not found', 'text/plain');
    return true;
  }

  // ---- a library of one's own
  if (p === '/library/index.json') { hit('library-index'); send(res, 200, library); return true; }
  if (p.startsWith('/library/')) {
    hit('library-file');
    const file = decodeURIComponent(p.slice('/library/'.length));
    if (librarySizes[file]) send(res, 200, stepBox(file.split('/').pop().replace(/\.[^.]+$/, ''), librarySizes[file]), 'text/plain'); else send(res, 404, 'not found', 'text/plain');
    return true;
  }
  return false;
}
