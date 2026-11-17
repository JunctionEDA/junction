// mass-properties.ts — volume, surface area and centre of mass of a body.  The smallest example of a worker
// service: `await kernel.call("mass-properties", { body: "<body id>" })`.
import { defineService } from "../kernel/service";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default defineService({
  name: "mass-properties",
  run(ctx, args) {
    const id = (args as { body?: string } | null)?.body;
    const body = ctx.state.bodies.find((b) => b.id === id);
    if (!body) throw ctx.fail("That body no longer exists.");
    const oc = ctx.oc as any;
    const g = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(body.shape, g, true, false, false);
    const volume = g.Mass(), c = g.CentreOfMass(), centre = ctx.k.xyz(c);
    c.delete();
    oc.BRepGProp.SurfaceProperties(body.shape, g, false, false);
    const area = g.Mass();
    g.delete();
    return { body: body.id, volume, area, centre };
  },
});
