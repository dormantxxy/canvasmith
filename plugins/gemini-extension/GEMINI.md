# Canvasmith

Canvasmith is a full layered image editor (brush, magic wand and lasso selections, crop, text,
shapes, gradients, fills, filters, adjustment layers). It opens in the user's web browser, not in
the terminal.

- When the user wants to edit, crop, annotate, retouch or mock up an image, or start a blank
  canvas, call `open_canvasmith`. Pass `image` as an **absolute** path (resolve relative paths
  against the current working directory first), a `~/` path, or an http(s) URL. For a blank
  canvas, pass `width` and `height` (for example 1200×628 for a social banner).
- Tell the user the editor is open in their browser and include the URL from the result, in case
  no tab appeared.
- Then call `wait_for_export`. It returns when the user clicks **Export image** in the tab, with
  the saved path and a preview image you can look at. If it times out, the editor is still open:
  ask the user whether they're done, and call it again rather than reopening the editor.
- Canvasmith doesn't edit images on its own. The user does the editing in the browser. Don't
  claim you changed the image; describe what the user exported.
