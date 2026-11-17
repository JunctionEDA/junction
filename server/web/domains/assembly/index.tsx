// index.tsx — the assembly domain's page bundle (static/dist/assembly.js): the assembly editor.
// Loaded by the app shell the first time an assembly tab is opened (web/platform/documents/host.ts).
import { createRoot } from "react-dom/client";
import { registerDocumentEditor } from "../../platform/documents/host";
import { AssemblyEditor } from "./ui/assembly";
import { AssemblyView } from "./ui/AssemblyView";

registerDocumentEditor({
  docTypes: ["assembly"],
  open(ctx) {
    const canvasHost = document.createElement("div");
    canvasHost.style.cssText = "position:absolute;inset:0";
    const assembly = new AssemblyEditor(ctx, canvasHost);
    const root = createRoot(ctx.el);
    root.render(<AssemblyView assembly={assembly} canvasHost={canvasHost} />);
    (window as unknown as { JunctionAssembly?: AssemblyEditor }).JunctionAssembly = assembly;
    return { close() { assembly.close(); root.unmount(); ctx.el.replaceChildren(); } };
  },
});
