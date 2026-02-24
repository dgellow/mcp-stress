import { Head } from "fresh/runtime";
import { define } from "../utils.ts";
import "../assets/styles.css";

export default define.page(function Home() {
  return (
    <>
      <Head>
        <title>mcp-stress — share runs</title>
      </Head>
      <div class="min-h-screen bg-gray-950 text-gray-100">
        <header class="border-b border-gray-800 px-8 py-6">
          <h1 class="text-xl font-semibold">mcp-stress</h1>
          <p class="text-sm text-gray-400 mt-1">
            Share stress test results
          </p>
        </header>

        <main class="px-8 py-6 max-w-2xl">
          <h2 class="text-lg font-medium mb-4">How to share a run</h2>

          <p class="text-gray-400 mb-4">
            Share the results of a stress test run by uploading it from the CLI.
            Shared runs get a unique URL you can send to anyone.
          </p>

          <div class="space-y-4">
            <div>
              <p class="text-gray-400 mb-2">Share your most recent run:</p>
              <pre class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm">
                <code>mcp-stress share latest</code>
              </pre>
            </div>

            <div>
              <p class="text-gray-400 mb-2">Share a specific run by name:</p>
              <pre class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm">
                <code>mcp-stress share my-run-name</code>
              </pre>
            </div>

            <div>
              <p class="text-gray-400 mb-2">List available runs:</p>
              <pre class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm">
                <code>mcp-stress history</code>
              </pre>
            </div>
          </div>
        </main>
      </div>
    </>
  );
});
