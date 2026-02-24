import { Head } from "fresh/runtime";
import { define } from "../utils.ts";
import { prisma } from "../src/db.ts";
import "../assets/styles.css";

export const handler = define.handlers({
  async GET(_ctx) {
    const runs = await prisma.run.findMany({
      select: {
        id: true,
        title: true,
        created_at: true,
        size_bytes: true,
        summary: true,
      },
      orderBy: { created_at: "desc" },
      take: 50,
    });

    return { data: { runs } };
  },
});

export default define.page<typeof handler>(function Home({ data }) {
  const { runs } = data;

  return (
    <>
      <Head>
        <title>mcp-stress — shared runs</title>
      </Head>
      <div class="min-h-screen bg-gray-950 text-gray-100">
        <header class="border-b border-gray-800 px-8 py-6">
          <h1 class="text-xl font-semibold">mcp-stress</h1>
          <p class="text-sm text-gray-400 mt-1">
            Shared stress test results
          </p>
        </header>

        <main class="px-8 py-6">
          {runs.length === 0
            ? (
              <p class="text-gray-500">
                No runs shared yet. Use{" "}
                <code class="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded text-sm">
                  mcp-stress share
                </code>{" "}
                to upload a run.
              </p>
            )
            : (
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-800">
                    <th class="pb-2 font-medium">Title</th>
                    <th class="pb-2 font-medium">Requests</th>
                    <th class="pb-2 font-medium">Req/s</th>
                    <th class="pb-2 font-medium">p50</th>
                    <th class="pb-2 font-medium">p99</th>
                    <th class="pb-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const s = run.summary as Record<string, unknown>;
                    const overall = s.overall as
                      | Record<string, number>
                      | undefined;
                    return (
                      <tr
                        key={run.id}
                        class="border-b border-gray-800/50 hover:bg-gray-900/50"
                      >
                        <td class="py-2.5">
                          <a
                            href={`/r/${run.id}`}
                            class="text-blue-400 hover:text-blue-300"
                          >
                            {run.title}
                          </a>
                        </td>
                        <td class="py-2.5 text-gray-400">
                          {(s.totalRequests as number)?.toLocaleString() ??
                            "—"}
                        </td>
                        <td class="py-2.5 text-gray-400">
                          {(s.requestsPerSecond as number)?.toFixed(1) ?? "—"}
                        </td>
                        <td class="py-2.5 text-gray-400">
                          {overall?.p50 !== undefined
                            ? `${overall.p50.toFixed(1)}ms`
                            : "—"}
                        </td>
                        <td class="py-2.5 text-gray-400">
                          {overall?.p99 !== undefined
                            ? `${overall.p99.toFixed(1)}ms`
                            : "—"}
                        </td>
                        <td class="py-2.5 text-gray-400">
                          {new Date(run.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </main>
      </div>
    </>
  );
});
