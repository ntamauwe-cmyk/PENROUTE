# Penroute master logo — drop zone

Place the official Penroute logo file here, exactly as supplied by the brand team:

```
public/brand/logo.svg    (or logo.png / logo.jpg / logo.webp)
```

Rules

- The app renders the file AS-IS — never recoloured, cropped or redrawn.
- Priority order when several are present: .svg → .png → .jpg → .webp.
- If the file already includes the "Penroute" wordmark, add an empty marker
  file named `wordmark-off` (no extension) next to it to hide the separate
  text label.

Automatic adoption — no code changes needed

The file is probed at runtime (see `src/lib/brand-logo.ts`) and picked up by:

- Sidebar navigation (desktop)
- Mobile bottom navigation
- Landing page header and footer
- Login / sign-up screens
- Payment receipts and certificates
- Browser favicon (swapped in after load)

Until the file is placed, a stand-in mark traced from the brand sheet is shown.

Note: PNG/JPG files with a transparent background work best, since the logo
appears on both white cards and the dark navy sidebar.
