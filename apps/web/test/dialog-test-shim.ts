if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.open = true;
  };

  HTMLDialogElement.prototype.close ??= function close() {
    this.open = false;
  };
}
