// jsdom has no Canvas 2D implementation; return null instead of logging
// "not implemented" so components take their no-context path quietly.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
