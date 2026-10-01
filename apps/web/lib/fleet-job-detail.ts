/** Run related-data loading only after the job itself is available. */
export async function loadFleetJobDetail(
  loadJob: () => Promise<boolean>,
  initializeRelatedData: () => void,
): Promise<boolean> {
  const loaded = await loadJob()
  if (loaded) initializeRelatedData()
  return loaded
}
