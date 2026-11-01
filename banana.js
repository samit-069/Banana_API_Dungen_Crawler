// banana.js - client for the third-party Banana API. Own code.
// INTEROPERABILITY: this is the only place that talks to the external service.
// Protocol: HTTPS GET, response body is JSON: { "question": "<image url>", "solution": <digit 0-9> }
// API docs: https://marcconrad.com/uob/banana/doc.php (author: Marc Conrad)

async function fetchOne() {
  // Read the URL at call time so tests can point it at a fake server.
  const url = process.env.BANANA_API || 'https://marcconrad.com/uob/banana/api.php';
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) { // one retry: the service is free and occasionally slow
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('Banana API status ' + res.status);
      const data = await res.json();
      const solution = Number(data.solution);
      // Validate everything we got from a third party before trusting it.
      if (typeof data.question !== 'string' || !/^https?:\/\//i.test(data.question) ||
          !Number.isInteger(solution) || solution < 0 || solution > 9) {
        throw new Error('Unexpected Banana API response');
      }
      return { image: data.question, solution };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// Fetch n puzzles in parallel (one HTTP request each; the API returns a random puzzle per call).
function fetchPuzzles(n) {
  return Promise.all(Array.from({ length: n }, fetchOne));
}

module.exports = { fetchPuzzles };
