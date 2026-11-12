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
| `giftEvent` | — | | Jewels gifts need their own alert design (#138). |

**There is no subscription event in the YouTube live chat.** New channel subscribers are
detected separately by polling, not by a `newSubscriberEvent` chat message.

## Public YouTube subscriber alerts (polling)

While YouTube chat is listening, `subscriptions.list` reads public subscribers from the
connected account. The first read in a listening period is silent; later newly detected
subscribers enter the same alert queue as Twitch follows as `ytsub` («Nuevo suscriptor»),
with a name and an optional validated thumbnail. Missing or failed images do not replace
the configured icon/media or prevent the named alert. The follower registry deduplicates
these entries, so reconnect recovery does not replay them.

`youtube.subscriberPollSeconds` defaults to 120 seconds, accepts a minimum nonzero interval
of 60 seconds, and uses 0 to disable polling. Only public subscriptions can be identified;
results can be delayed or capped by the API. List pages and the account-total read share
the daily quota with chat. `quotaExceeded` stops this polling until the next listening
period; stale responses from an older period cannot stop or consume the new baseline.
Anonymous registry estimates do not generate alerts in this feature. Goal totals remain
separate (#132), and a subscriber event cannot increment a different configured channel.

## Followers gained while offline

The local registry in `data/followers.json` records follower ID, name, follow date,
source (`offline` or `live`) and thanked state. Startup and reconnect synchronization
recover entries without replaying alerts. The first synchronization establishes a
baseline, not a list of everyone who followed before antena was installed. Live Twitch
follows and recovered entries are deduplicated by ID, or case-insensitive name if no ID
is available.

| Platform | Reader | Bounded history |
| --- | --- | --- |
| Twitch | `GET /helix/channels/followers`, using `followed_at` | Up to ten pages of 100 per sync; an incomplete backlog stays `partial` without advancing the checkpoint. |
| YouTube | OAuth `subscriptions.list`, `myRecentSubscribers=true`, `part=snippet,subscriberSnippet` | Public subscribers only; up to twenty pages of 50 for the baseline, four pages on later syncs. The API may impose its own limit. |

YouTube requires the channel's account to be connected. Dates come from
`snippet.publishedAt` when available; missing dates remain unknown. Unknown subscribers
with older dates are learned silently rather than counted as new. The anonymous count
uses the same OAuth account's `channels.list(mine=true)` total: `max(0, total growth − new
names)`. This is a **net estimate**, not an exact count of private new subscribers:
unsubscribes can cancel out new subscriptions, and YouTube rounds totals from 1,000.
Missing totals do not produce an anonymous count; a falling total never deletes records.

`GET /api/followers` lists entries, anonymous counts and sync status; `?pending=true`
filters thanked records out. `POST /api/followers/thank` accepts `{ "ids": ["<id>"] }`
or `{ "all": true }`; `all` includes anonymous counts and entries without an ID. Invalid
bodies return 400 without changes; an unreadable registry rejects thank updates with 503.
An additive selective form, `{ "entries": [{ "platform": "twitch", "id": "<id>" },
{ "platform": "youtube", "name": "<name>" }], "anonymous": ["<at>"] }`, targets
platform/id pairs, platform/name pairs only for ID-less entries, and anonymous YouTube
records by timestamp (`null` is allowed for an unknown timestamp). Either list may be omitted.
`?pending=true&shown=true` also returns the exact records selected for the widget. The
`/widget/thanks` layer displays pending offline entries one at a time and optionally a final
anonymous count; its window and platforms use saved settings. Unknown dates are included,
and with no archived session the last-stream window has no cutoff. The panel's individual
and confirmed bulk actions apply immediately; bulk marks exactly the widget selection.
Recovered followers are never replayed as on-screen alerts or sent to chat.

Known limits: the checkpoint is per platform, not per account, so use the same connected
account for consistent history. Strict timestamp checkpoints can miss Twitch follows in
the checkpoint's same second. A bounded or private subscriber list is not a complete
historical record.

## Manual check

With the [Twitch CLI](https://dev.twitch.tv/docs/cli/) against a local EventSub WebSocket, or
with real events on stream: `twitch event trigger channel.follow`, `channel.subscribe`,
`channel.subscription.gift`, `channel.cheer`, `channel.raid` and
`channel.channel_points_custom_reward_redemption.add`, and check each alert on the overlay.
