export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new Error("The upstream service timed out. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}
