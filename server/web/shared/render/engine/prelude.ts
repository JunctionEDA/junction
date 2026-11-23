// prelude.ts — imported first by the bundle (index.ts).  The editor's own bundle already carries a three.js, which
// marks the page with `__THREE__`; this bundle's copy would then warn on the console that two are loaded.  They
// never share an object (api.ts: nothing that crosses into the engine is a three.js object), so the mark is set
// aside while this copy loads and put back after it (index.ts).
const w = window as unknown as { __THREE__?: string; __junctionThree?: string };
if (w.__THREE__) { w.__junctionThree = w.__THREE__; delete w.__THREE__; }
export {};
