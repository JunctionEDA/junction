// The Board panel: the board this part studio drives (boardlink/Panel.tsx).
import { definePanel } from "../core/tool";
import { BoardLinkPanel } from "../boardlink/Panel";

export default definePanel({ id: "boardlink", title: "Board", side: "right", order: 40, render: (studio) => <BoardLinkPanel studio={studio} /> });
