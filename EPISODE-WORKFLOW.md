# Episode release workflow

Written 2026-07-30, after shipping episode 64 (Coach Joe and Denise Kennedy).
The goal is to get an episode out in about 20 minutes instead of an evening.

## What each system actually does

| Step | Who does it | Automatable? |
|---|---|---|
| Record | Riverside | n/a |
| Publish audio/video | Spotify for Creators | **No.** No publishing API exists. Always manual. |
| Episode art (square 3000) | `make_episode_art.py` | Yes, one command |
| YouTube thumbnail (16:9) | `make_thumbnail.py` | Yes, one command |
| Upload to YouTube | `youtube-tools/upload.py` | Yes, one command |
| Website episode list | reads the RSS directly | **Already automatic.** Do nothing. |
| Email to the list | GHL campaign | Template, then one send |
| Facebook post | GHL Social Planner | Template, then schedule |

The website needs no action at all. That was fixed on 2026-07-30 when the
rss2json proxy was removed; `js/main.js` now reads
`https://anchor.fm/s/f4cac4f8/podcast/rss` directly and picks up new episodes
within about five minutes.

## The 20 minute run sheet

**1. Publish on Spotify first (5 min).** Everything downstream keys off the
RSS. Upload the Riverside MP4, paste the description, set episode art.

Write the description as **unbroken paragraphs**. Do not hard-wrap lines.
Spotify converts every line break into its own `<p>`, which is what turned
episode 64's opening into 52 fragments and produced "his wifeDenise" on the
website.

**2. Generate the art (2 min).** From the episode video:

```
cd ~/Documents/Claude\ Folder/youtube-tools

# pick a frame: contact sheet across the interview
for t in 900 1500 1900 2400 3000 3600; do
  ./bin/ffmpeg -ss $t -i VIDEO.mp4 -frames:v 1 -q:v 2 frames_ep/f$t.jpg -y
done

# square art for Spotify
venv/bin/python make_episode_art.py --frame frames_ep/CHOSEN.jpg \
  --out ep65-spotify.jpg \
  --title "GUEST NAME|SECOND LINE" \
  --kicker "EPISODE 65  .  THE 7K REVELATION PODCAST" \
  --subtitle "one line hook"

# 16:9 thumbnail for YouTube (guest on the left, navy panel right)
./bin/ffmpeg -i frames_ep/CHOSEN.jpg -vf "crop=1680:945:200:15,scale=-1:720,pad=1280:720:0:0:0x1E3A5F" yt_bg.jpg -y
venv/bin/python make_thumbnail.py --frame yt_bg.jpg --out ep65-youtube.jpg \
  --kicker "THE 7K REVELATION PODCAST" --title "GUEST|NAME" \
  --subtitle "one line hook" --subtitle2 "EPISODE 65" --scrim-start 0.60
```

Choosing the frame is the only judgment call. Prefer a moment where the guest
is looking at camera with headroom, not mid-word.

**3. YouTube (3 min).** `upload.py` with title, description, tags, thumbnail,
and playlist `PLRjfCV4IkPtrp9zcJ0nkYvg4IVISzE9zG`. Expect to rerun
`authorize.py` roughly weekly.

Always send the **full snippet** on any update. A partial `snippet` update
silently wipes the fields you leave out.

**4. Email (5 min).** Duplicate the saved GHL template, swap five things:
episode number, guest name, hook paragraph, episode art URL, YouTube URL.
Send a test to yourself, check it on a phone, then send.

**5. Facebook (2 min).** Social Planner, using the saved post template. Post
the episode now; schedule any event or meeting post for a different day.

## What is worth building once

**A. One command for both images.** Today the square and the 16:9 are two
invocations with a hand-written ffmpeg crop between them. A single
`make_episode_assets.py --video X --timestamp 1900 --episode 65` that emits
both, correctly cropped, would remove the fiddliest step. Half a day of work,
saves ten minutes every week and removes the crop guesswork.

**B. Host episode art on the site, not Spotify's CDN.** Email images must live
at `alfanoministries.com/assets/email/`. Note `assets/` is gitignored, so new
files need `git add -f`. Worth a tiny script that copies the art in, force-adds,
and pushes.

**C. An RSS watcher, only if the above gets boring.** The Cloudflare worker in
`workers/` already holds a GHL private token and talks to the v2 API with
location `AIPTqymDwrSMF9zx8Pul`. A Cron Trigger could poll the podcast feed and,
on a new episode, write the title and links into GHL custom values so the email
template fills itself.

Be realistic about the ceiling: GHL's v2 API does not cleanly expose "send a
broadcast to the whole list." It can prepare, not send. The final send stays a
button you press, and that is probably correct for something going to your
whole list anyway.

## Traps already paid for

- **Spotify hard-wraps become paragraphs.** Write flowing text.
- **Episode art is square; the site cards are square now too.** Art with type at
  the bottom used to get cropped through the title.
- **Spotify's app shows video stills, not episode art.** Custom art still matters
  for Apple Podcasts, the website, and shares. Don't judge it from Spotify.
- **The Boost toggle on Facebook can flip if the window resizes mid-flow.** Check
  it is off on the Post settings screen before publishing.
- **Facebook offers to convert dated posts into Events.** For a real meeting an
  Event is genuinely better than a post; consider it deliberately.
