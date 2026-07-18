# 实现清单

1. [x] Hub：`GET /health` 增加 `feishuMode` / `ownerBound` / `needsPairing`
2. [x] `computePairingHealth` + `shouldAutoPair` / `fetchHubPairingStatus`
3. [x] Bridge：`autoPairAttempted`；`register_ok` 后查 health → 自动 `pair_begin`
4. [x] 单测（pairing / hub-autostart）
5. [x] README / docs / multi-pi-lark-hub.md
6. [x] typecheck + test（91 全绿）
