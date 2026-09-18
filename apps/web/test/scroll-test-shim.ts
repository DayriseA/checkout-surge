// jsdom has no layout or scrolling; viewport placement is verified in Chrome.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}
