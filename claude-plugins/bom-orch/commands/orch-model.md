---
description: 오케스트레이션 모델 설정을 조회하거나 바꿉니다
argument-hint: "[vendor] [tier] [model]"
---

orch-model 스킬을 따라 오케스트레이션 모델 설정을 처리하세요. 인자: $ARGUMENTS

인자가 비어 있으면 `orch_config` 를 인자 없이 불러 현재 설정을 보여 주세요. 값을 바꾸는
호출에는 `vendor` 와 `tier` 가 **둘 다** 있어야 합니다 — 나머지 규칙은 전부 orch-model
스킬에 있습니다. 이 커맨드는 Claude Code 에서만 보이고 Codex 는 스킬만 읽으므로, 여기에
스킬에 없는 내용을 적지 마세요.
