/**
 * 렌더러에 노출하는 유일한 통로.
 *
 * 채널을 그대로 넘겨주는 와일드카드 전달자는 두지 않는다 — 렌더러가 임의의 IPC
 * 를 부를 수 있게 되면 contextIsolation 이 무의미해진다
 * (docs/design/01-architecture.md). 채널은 필요할 때 하나씩 이름을 붙여 연다.
 *
 * sandbox: true 라서 이 파일은 CommonJS 로 컴파일된다 (tsconfig.node.json).
 */
import { contextBridge } from "electron";
import type { MarkExtractApi } from "../shared/api";

const api: MarkExtractApi = {
  version: process.versions.electron,
};

contextBridge.exposeInMainWorld("markExtract", api);
