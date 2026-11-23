export interface BoardScrollMeasurements {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

export interface BoardScrollHints {
  left: boolean
  right: boolean
}

export function boardScrollHints(measurements: BoardScrollMeasurements): BoardScrollHints {
  const { scrollLeft, clientWidth, scrollWidth } = measurements
  return {
    left: Number.isFinite(scrollLeft) && scrollLeft > 0,
    right: Number.isFinite(scrollLeft)
      && Number.isFinite(clientWidth)
      && Number.isFinite(scrollWidth)
      && scrollLeft + clientWidth < scrollWidth - 1,
  }
}
