# Platform events → alerts

Which real platform event produces which antena alert, checked against the official
documentation (Twitch EventSub reference, YouTube Live Streaming API `liveChatMessages`).
Each row is pinned by `test/event-mapping.test.mjs`.

## Twitch (EventSub)

| EventSub type (version) | Alert | Fields used | Notes |
| --- | --- | --- | --- |
| `channel.follow` (2) | `follow` | `user_name` | Also adds to the follower goal total (#132). |
| `channel.subscribe` (1) | `sub` | `user_name`, `tier` | Ignored when `is_gift` is true: the gift alert covers it. |
| `channel.subscription.message` (1) | `resub` | `user_name`, `tier`, `cumulative_months`, `message.text` | |
| `channel.subscription.gift` (1) | `giftsub` | `user_name`, `total`, `tier` | Anonymous gifts show «Anónimo». |
| `channel.cheer` (1) | `cheer` | `user_name`, `bits`, `message` | Cheermotes are stripped; anonymous cheers show «Anónimo». |
| `channel.bits.use` (1) | `cheer` | `user_name`, `bits`, `message.text`, `power_up.type` | Only `power_up` / `custom_power_up`: Power-ups spend bits without a `channel.cheer`. Type `cheer` is ignored (already alerted by `channel.cheer`). |
| `channel.raid` (1) | `raid` | `from_broadcaster_user_name`, `viewers` | |
| `channel.channel_points_custom_reward_redemption.add` (1) | `redemption` | `user_name`, `reward.title`, `reward.cost`, `user_input` | |

Redelivered notifications keep the same message id (`tw:<message_id>`) and the bus drops the
second copy.

## YouTube (live chat)

| `snippet.type` | Alert | Fields used | Notes |
| --- | --- | --- | --- |
| `superChatEvent` | `superchat` | `amountMicros`, `amountDisplayString`, `currency`, `userComment` | |
| `superStickerEvent` | `supersticker` | `amountMicros`, `amountDisplayString`, `superStickerMetadata.altText` | |
| `newSponsorEvent` | `member` | `memberLevelName`, `isUpgrade` | Channel memberships only (YouTube Partner Program). |
| `memberMilestoneChatEvent` | `milestone` | `memberMonth`, `memberLevelName`, `userComment` | Channel memberships only. |
| `membershipGiftingEvent` | `giftmember` | `giftMembershipsCount`, `giftMembershipsLevelName` | Channel memberships only. |
| `giftMembershipReceivedEvent` | — | | One per receiver of a gift: the gifting event already alerts once. |
| `giftEvent` | — | | Jewels gifts need their own alert design (separate issue). |

**There is no subscription event in the YouTube live chat.** A new channel subscriber never
arrives here; see #134 (polling) and #132 (channel totals for goals).

## Manual check

With the [Twitch CLI](https://dev.twitch.tv/docs/cli/) against a local EventSub WebSocket, or
with real events on stream: `twitch event trigger channel.follow`, `channel.subscribe`,
`channel.subscription.gift`, `channel.cheer`, `channel.raid` and
`channel.channel_points_custom_reward_redemption.add`, and check each alert on the overlay.
