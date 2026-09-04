# Canonical taxonomy — single source of truth

Both the triage engine and the seed data must use these exact keys. Changing one
without the other silently misroutes reports.

## Departments (`departments.key`)
| key | name |
| --- | --- |
| `maintenance`  | Course Maintenance |
| `cart_fleet`   | Cart Fleet |
| `pro_shop`     | Pro Shop |
| `pace_of_play` | Player Assistance |
| `f_and_b`      | Food & Beverage |
| `caddie`       | Caddie & Valet |
| `management`   | Management |

## Categories (`reports.category`, `routing_rules.category`)
| category | routes to | ack SLA | resolve SLA |
| --- | --- | --- | --- |
| `pace_of_play`        | `pace_of_play` | 10 | 30 |
| `course_maintenance`  | `maintenance`  | 15 | 240 |
| `cart_issue`          | `cart_fleet`   | 10 | 45 |
| `pro_shop`            | `pro_shop`     | 15 | 60 |
| `f_and_b`             | `f_and_b`      | 10 | 30 |
| `restroom_facilities` | `maintenance`  | 20 | 120 |
| `practice_facility`   | `pro_shop`     | 30 | 240 |
| `safety`              | `management`   |  5 | 30 |
| `caddie_valet`        | `caddie`       | 10 | 30 |
| `needs_review`        | `management`   | 15 | 120 |

`needs_review` is where low-confidence triage lands. The model never invents a
category outside this list.

## Urgency (`reports.urgency`)
`low` | `normal` | `high` | `urgent`

`urgent` is reserved for anything with a safety dimension — injury, lightning,
a cart in water, an aggressive animal. Never assigned for inconvenience.
