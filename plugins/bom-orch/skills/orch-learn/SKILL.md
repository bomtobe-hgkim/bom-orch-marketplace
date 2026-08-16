---
name: orch-learn
description: 오케스트레이션이 무엇을 배웠는지 보거나, 지난 실행의 자동 채점을 사람 손으로 정정할 때 씁니다.
---

# 학습 통계와 정정

- `orch_stats` — 태스크 클래스 × 결정 축 셀마다 관측 수와 밴딧 활성 여부를 봅니다.
  `runs` 를 주면 최근 실행 목록도 함께 옵니다.
  `task_class` 는 **조회 필터로도** 씁니다 — 주면 그 클래스의 셀만 옵니다. 다만 최근
  실행 목록은 거르지 **않습니다**(거르면 요청한 수를 못 채우면서 「그 클래스의 최근 N
  건」처럼 보입니다).
- `orch_reward` — 지난 실행의 평가를 사람 손으로 정정합니다. 멱등입니다.

## 인자

| 도구 | 인자 | 필수 | 기본값 | 허용값 |
| --- | --- | --- | --- | --- |
| `orch_stats` | `task_class` | 아니오 | — | `code:test-bearing`, `code:no-tests`, `prose`, `analysis` |
| `orch_stats` | `runs` | 아니오 | `0` | 0~50 정수 |
| `orch_stats` | `reset` | 아니오 | `false` | — |
| `orch_reward` | `run_id` | 예 | — | — |
| `orch_reward` | `good` | 예 | — | — |
| `orch_reward` | `note` | 아니오 | — | — |

## 응답의 최상위 필드

| 필드 | 뜻 |
| --- | --- |
| `threshold` | 밴딧이 돌기 시작하는 관측 수 |
| `posteriors` | 사후분포 파일을 읽었는가 — `ok` 또는 `unreadable` |
| `journal` | 실행 저널을 읽었는가 — `ok` · `unreadable` · 안 물었으면 `skipped` |
| `cells` | 셀 목록. 아래 표를 보세요 |
| `recent` | 최근 실행 목록. `runs` 를 줬을 때만 옵니다 |
| `recentFiltered` | 최근 목록이 `task_class` 로 걸러졌는가. 늘 거짓입니다 |
| `reduced` | 응답 상한 때문에 무엇을 줄였는지. 줄일 것이 없으면 이 필드 자체가 없습니다 |
| `reset` | 지우기 결과. `reset` 을 줬을 때만 오고, 그때는 위의 다른 필드가 없습니다 |

`reset` 안에는 `reset.taskClass`(좁힌 범위. 전체 지우기면 `null`) ·
`reset.asked`(범위에 든 셀 수. 전체 지우기는 세지 않으므로 `null`) ·
`reset.cleared`(실제로 지운 수) · `reset.failed`(못 지운 셀 수) ·
`reset.cellKeys`(지운 셀 키 목록. 전체 지우기면 빈 배열이 아니라 `null` 이니 길이를 세기 전에 먼저 보세요) ·
`reset.posteriors`(사후분포 파일을 읽었는가. 위 최상위 표의 같은 이름과 같은 값을 씁니다) ·
`reset.snapshot`(지우기 전 원본·세대의 회복 경로. 지울 것이 없으면 `null`; 있으면 path 와
generationPath · restore 를 가진 객체) 가 있습니다.

★ **전체 지우기는 읽을 수 없는 파일도 회복시킵니다.** 먼저 `reset.snapshot.path`에 원본
바이트와 `reset.snapshot.generationPath`에 같은 시점의 세대를 남깁니다. 복구할 때는
`reset.snapshot.restore`대로 **관련 서버를 먼저 중지한 상태에서** learning.generations.prev.json 을
learning.generations.json 으로 **먼저** 복사하고, posteriors.prev.json 을 posteriors.json 으로
복사한 뒤 서버를 다시 시작하세요. 둘 중 하나만 복구하거나 두 복사 사이에 writer가 끼면 수치는
돌아와도 옛 실행은 여전히 만료(`appliedCurrent:false`)이거나 새 상태를 덮을 수 있습니다. 그때
`reset.posteriors` 가 `unreadable` 이고
`reset.cleared` 는 0 입니다 — 「지울 것이 없었다」가 아니라 「몇 개였는지 셀 수가 없었다」는
뜻이고, 봉투의 신뢰도도 `unverified` 로 옵니다.

성공한 파괴적 reset은 두 스냅샷을 **최신 한 쌍**으로 덮습니다. 오래된 복구점도 필요하면 다음
reset 전에 두 파일을 함께 다른 안전한 위치에 복사하세요.

★ **`reset.cleared` 만 읽으면 안 됩니다.** 범위 reset도 셀 목록을 한 coordinator·스냅샷·WAL
목표로 처리합니다. WAL을 쓰기 전 실패면 아무 target도 적용하지 않고, 쓴 뒤 실패면 다음
읽기/재시도가 같은 전체 목표로 수렴합니다. 실패 응답에는 `reset.failed` 가 요청한 셀 수와
같고 봉투의 신뢰도는 `unverified` 로 옵니다 — 멱등이므로 **같은 인자로 그대로 다시 부르거나
한 번 조회**하면 됩니다. 실패 사유는 notice에 가며, 셀이 많으면 앞의 몇 건만 싣고 나머지는
접습니다. 접힌 건수까지 세려면 `reset.failed` 를 보세요.

## 셀 하나가 내는 필드

| 필드 | 뜻 |
| --- | --- |
| `cellKey` | 태스크 클래스와 축을 이은 키 |
| `taskClass` | 이 셀의 태스크 클래스. 구분자가 없는 손수 쓴 키는 `null` |
| `axis` | 결정 축 이름. 구분자가 없으면 `null` |
| `arms` | 팔마다의 알파·베타 |
| `observations` | **그 축의 팔로** 센 관측 수. 모르는 축이면 `null` — 0 이 아닙니다 |
| `banditActiveByDefault` | 그냥 부른 실행에서 이 셀의 밴딧이 도는가 |
| `banditActiveIfAllowSingle` | `allow_single` 을 켠 실행에서 도는가 |
| `optInArms` | 호출자가 명시로 허용해야 후보가 되는 팔 |
| `note` | 그 축을 읽을 때 함께 알아야 하는 사실 |
| `unknownAxis` | 지금 코드가 모르는 축이라는 표시 |

★ **활성 여부는 불리언 하나가 아니라 둘입니다.** `mix` 축은 `orch_run` 을 `allow_single`
과 함께 부른 실행에서만 후보 팔이 둘이 되므로, 그 축에서 두 값이 갈립니다. `mix` 밖의
축은 두 값이 늘 같습니다. 하나만 읽으면 절반이 틀립니다.

`observations` 는 셀 전체 팔의 합이 아니라 **그 축의 팔**로만 센 수입니다 — 옛 팔 이름이
남아 있는 셀은 합이 커도 관측이 0 일 수 있습니다.

## 최근 실행 하나가 내는 필드

| 필드 | 뜻 |
| --- | --- |
| `runId` | 이 실행을 `orch_reward` 에 넘길 식별자 |
| `at` | 원래 실행 시각 |
| `taskClass` | 실행의 태스크 클래스 |
| `stopReason` | 실행이 끝난 이유 |
| `grade` | 실행 결과의 자동 등급 |
| `appliedGrade` | **기록 당시** 실제 반영했던 등급. reset 뒤에도 과거 사실로 남습니다 |
| `appliedCurrent` | 그 반영이 현재 reset 세대에도 유효한가. `appliedAxes`가 없는 옛 행 또는 세대 sidecar를 읽지 못한 경우에는 `null` |
| `appliedAxes` | 기록 당시 반영한 축. 옛 형식처럼 알 수 없으면 `null` |
| `artifacts` | 그 실행이 남긴 artifact 를 지금 열어 본 결과. 원래 ref 에 `exists`·`expired` 를 더합니다. 확인하지 않았거나 ref 를 남기지 않은 옛 행은 `null` |

## artifact 하나가 내는 필드

`artifacts` 의 각 항목은 저널에 동결된 ref 를 그대로 담고 두 필드를 더합니다.

| 필드 | 뜻 |
| --- | --- |
| `exists` | 그 경로에 지금도 파일이 있는가 |
| `expired` | 보존 기간이 지났거나 바이트가 기록된 ref 와 더는 일치하지 않는가 |

artifact 가 만료돼도 `orch_reward` 정정은 막히지 않습니다. 보상 권위는 실행이 동결한 선택
(arm)이지 패치 내용이 아닙니다. 정정을 실제로 막는 것은 reset 세대 만료뿐입니다.

`appliedGrade` 를 reset 뒤에 `null` 로 바꾸지 않습니다. 대신 `appliedCurrent:false` 가 그
기여가 현재 세대에서 만료됐음을 말합니다. 세대 sidecar가 **없는** 정상 옛 상태는 generation 0으로
읽으므로 `appliedCurrent`를 계속 true/false로 판정할 수 있습니다. `null`은 sidecar가 없다는
뜻이 아니라, 그 행의 적용 축 또는 현재 세대를 신뢰할 수 없다는 뜻입니다.

## 한 실행이 만드는 관측은 최대 하나입니다

실행 하나는 등급을 최대 하나 만들고, 한 축은 최대 한 번만 갱신됩니다. 이긴 후보에 성공을
주면서 진 후보에 실패를 함께 주는 이중계상은 하지 않습니다.

- **성공** — 선택된 후보가 `verified` 일 때만.
- **실패** — 모든 후보가 신뢰 가능한 기계 증거(안정적으로 재현된 테스트 실패)나 명시적인
  정책 위반으로 떨어졌을 때만.
- **그 밖에는 기권합니다** — verifier 만 FAIL 이거나, 테스트를 못 믿거나, 결과가 흔들리거나,
  `tie`·`blocked`·데드라인·provider 장애로 끝난 실행은 사후분포를 건드리지 않습니다.

기권한 실행에도 **정정할 곳은 남습니다** — 보상 가능한 축 목록이 그것이고, 사람 손 정정은
바로 그런 실행을 위해 있습니다. 최근 실행 행의 `appliedAxes` 가 비어 있어도 정정은 됩니다.

어느 축이 갱신될 수 있는지는 그 축이 이 실행에서 **실제 선택이었는가**로 정해집니다.

- placement 축 — 후보가 하나일 때만. 후보 둘을 돌리면 두 배치가 다 실행됐으므로 어느
  쪽이 결과를 냈다고 말할 수 없습니다.
- mix 축 — 후보가 하나일 때는 `orch_run` 의 `allow_single` 로 단일 벤더가 실제 후보였던
  호출에서만. 후보가 둘일 때는 두 lane 이 교차검증을 끝냈고 결과가 `single_survivor` 가
  아닐 때 한 번만.
- tier 축 — 평가된 모든 lane 이 같은 추상 tier 를 실제로 썼을 때만.
- 역할을 직접 지정했거나 벤더가 모자라 선택 자체가 없었으면 아무 축도 갱신하지 않습니다.
- rewrite 축은 **폐기됐습니다.** 새 실행은 이 축을 고르지도 보상하지도 않지만, 옛 관측은
  지우지 않고 조회·수동 정정용으로 남겨 둡니다.

## 정정

`orch_reward` 는 이미 반영된 기여를 되돌리고 새 등급을 적습니다. 그래서 같은 `run_id` 로
여러 번 불러도 결과가 같습니다. `run_id` 는 `orch_stats` 를 `runs` 와 함께 불러서 봅니다.

★ **정정 권위는 실행이 동결한 선택입니다.** 저널 행에는 그 실행이 실제로 돌린 축과 **팔**이
함께 얼려져 있습니다. 정정은 그 값만 읽습니다 — 나중에 재구성하면 다중 후보에서 아무 lane 도
돌리지 않은 팔에 보상이 갈 수 있기 때문입니다. 그 값이 손상된 행은 한 바이트도 고치지 않고
실패로 끝냅니다(옛 형식으로 되돌아가 추측하지 않습니다).

★ **수동 정정과 자동 학습의 pre-WAL 실패는 다릅니다.** `orch_reward`가 WAL을 쓰기 **전**
실패하면 기존 posterior와 기존 journal 행은 그대로이고 `failed` 봉투만 나옵니다. WAL을 쓴
**뒤** 실패하면 complete target이 pending에 남을 수 있으므로, 다음 읽기 또는 같은 `run_id`
재시도가 posterior와 journal을 정확히 한 번 수렴시킵니다. 어느 경우에도 저널 행을 손으로
덮어쓰지 마세요.

자동 orchestration은 부가 기능인 학습을 이유로 실행 결과를 실패시키지 않습니다. 자동 학습이
posterior target을 만들지 못해 WAL을 쓰기 **전** 실패하면, 실행은 성공하고
`appliedGrade:null`과 보상 가능한 축 목록이 있는 fallback journal 행을 남겨 나중의 `orch_reward`가
수동으로 반영할 수 있게 합니다. 이 fallback은 자동 학습 전용 계약이며 `orch_reward` 자신의
pre-WAL 실패가 새 null-applied 행을 만든다는 뜻은 아닙니다.

★ **reset 이전 실행은 만료될 수 있습니다.** 그 실행의 관련 셀 세대가 지워졌다면
`orch_reward` 는 새 증거로 다시 넣지 않고 `invalid` 으로 거부합니다. 새 orchestration 을
실행해 현재 세대의 `run_id` 를 만든 뒤 정정하세요.

`note` 를 안 주면 그 실행에 적혀 있던 이전 메모가 지워집니다(그 사실을 notice 로 알려
줍니다). 남기려면 같은 문장을 다시 주세요.

## 지우기

`reset` 은 사후분포를 지웁니다.

- `task_class` 를 함께 주면 **그 클래스의 셀만** 지웁니다.
- `task_class` 없이 부르면 **전부** 지웁니다. 실제로 지운 셀이 있을 때만 해당 세대를
  무효화하고 snapshot을 갱신합니다. snapshot이 있으면 `reset.snapshot.restore`의 **두 파일·순서**대로
  복사해 수치와 세대를 함께 복구할 수 있습니다.
- 구분자가 없는 손수 쓴 셀 키는 어떤 범위 지우기에도 안 걸립니다 — 그런 셀을 없애는
  길은 `task_class` 없는 전체 지우기 하나뿐입니다.
- `reset` 과 `runs` 를 **함께 주면 `runs` 는 버려집니다** — 지우기 응답에는 최근 실행
  목록을 실을 자리가 없습니다. 버렸다는 사실은 notice 로 알려 줍니다. 목록이 필요하면
  `reset` 없이 다시 부르세요.
