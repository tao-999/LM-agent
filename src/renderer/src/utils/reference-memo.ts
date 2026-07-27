export function createReferenceMemoizedProjection<TState, TResult>(
  selectSources: (state: TState) => readonly unknown[],
  project: (state: TState) => TResult
): (state: TState) => TResult {
  let previousSources: readonly unknown[] | undefined
  let previousResult: TResult | undefined
  return (state) => {
    const sources = selectSources(state)
    if (
      previousSources &&
      previousResult !== undefined &&
      previousSources.length === sources.length &&
      sources.every((source, index) => Object.is(source, previousSources?.[index]))
    ) {
      return previousResult
    }
    previousSources = sources
    previousResult = project(state)
    return previousResult
  }
}
