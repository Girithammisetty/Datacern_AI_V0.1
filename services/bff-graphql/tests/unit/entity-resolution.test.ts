import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/**
 * Downstream double for the BRD 56 entity-resolution steward surface:
 * dataset-service (:8304) owns runs / clusters / candidates / materialize;
 * agent-runtime (:8306) mints the four-eyes merge proposal.
 */
function downstream() {
  return mockFetch((req: CapturedRequest) => {
    // --- dataset-service: run + persist resolution --------------------------
    if (req.path === "/api/v1/datasets/ds-1/entity-resolution" && req.method === "POST") {
      return {
        status: 200,
        body: { data: {
          dataset_id: "ds-1", entity_type: "claimant", record_count: 14,
          resolved_entity_count: 12, merged_cluster_count: 1, review_candidate_count: 1,
          run_id: "run-9", config_id: "cfg-9", config_version: 1,
        } },
      };
    }
    // --- dataset-service: list runs -----------------------------------------
    if (req.path === "/api/v1/datasets/ds-1/resolution-runs" && req.method === "GET") {
      return {
        status: 200,
        body: { data: [{
          run_id: "run-9", dataset_id: "ds-1", config_id: "cfg-9", entity_type: "claimant",
          record_count: 14, resolved_entity_count: 12, merged_cluster_count: 1,
          review_candidate_count: 1, status: "completed", created_by: "steward",
          created_at: "2026-07-17T00:00:00Z",
        }] },
      };
    }
    // --- dataset-service: run detail (clusters + lineage) -------------------
    if (req.path === "/api/v1/resolution-runs/run-9" && req.method === "GET") {
      return {
        status: 200,
        body: { data: {
          run_id: "run-9", dataset_id: "ds-1", entity_type: "claimant", record_count: 14,
          resolved_entity_count: 12, merged_cluster_count: 1, review_candidate_count: 1,
          status: "completed",
          clusters: [{
            resolved_entity_id: "ent:claimant:CLM-1001", member_count: 3, confidence: 1.0,
            method: "deterministic",
            members: [
              { member_pk: "CLM-1001", method: "deterministic", evidence: [] },
              { member_pk: "CLM-1002", method: "deterministic", evidence: [] },
              { member_pk: "CLM-1003", method: "deterministic", evidence: [] },
            ],
          }],
        } },
      };
    }
    // --- dataset-service: merge candidates ----------------------------------
    if (req.path === "/api/v1/resolution-runs/run-9/merge-candidates" && req.method === "GET") {
      return {
        status: 200,
        body: { data: [{
          id: "cand-1", run_id: "run-9", dataset_id: "ds-1", entity_type: "claimant",
          left_pk: "CLM-1001", right_pk: "CLM-2002", score: 0.943,
          evidence: { policy_no: "P-9" }, status: "pending", proposal_id: null,
          decided_by: null, decided_at: null, created_at: "2026-07-17T00:00:00Z",
        }] },
      };
    }
    // --- dataset-service: materialize golden-record dataset -----------------
    if (req.path === "/api/v1/resolution-runs/run-9/materialize" && req.method === "POST") {
      return {
        status: 200,
        body: { data: {
          resolved_dataset_id: "ds-resolved", resolved_dataset_urn: "wr:t-42:dataset:dataset/ds-resolved",
          name: "resolved_claimant", row_count: 12,
          columns: ["resolved_entity_id", "member_count", "confidence", "method", "amount"],
          version_no: 1, iceberg_table: "bronze.t.ds_resolved",
        } },
      };
    }
    // --- agent-runtime: four-eyes merge proposal ----------------------------
    if (req.path === "/api/v1/entity-merges" && req.method === "POST") {
      return {
        status: 201,
        body: { data: { proposal_id: "prop-1", status: "pending", executed: false, run_id: "run-syn" } },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: req.path } } };
  });
}

describe("entity-resolution resolvers (BRD 56 steward surface)", () => {
  it("resolveEntities runs + persists and maps the run summary", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);

    const res = await server.executeOperation(
      { query: `mutation {
        resolveEntities(datasetId:"ds-1", input:{
          pkColumn:"claim_id",
          config:{ entityType:"claimant", deterministicKeys:[["policy_no"]], autoMergeThreshold:0.85, reviewThreshold:0.6 }
        }) { datasetId entityType recordCount resolvedEntityCount mergedClusterCount reviewCandidateCount runId configVersion }
      }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(body?.data?.resolveEntities).toMatchObject({
      datasetId: "ds-1", entityType: "claimant", recordCount: 14,
      resolvedEntityCount: 12, mergedClusterCount: 1, reviewCandidateCount: 1,
      runId: "run-9", configVersion: 1,
    });
    // The steward-config maps camel→snake and always persists (persist:true).
    const call = requests.find((r) => r.path === "/api/v1/datasets/ds-1/entity-resolution");
    expect(call?.body).toMatchObject({
      pk_column: "claim_id", persist: true,
      config: { entity_type: "claimant", deterministic_keys: [["policy_no"]] },
    });
    expect(call?.headers.authorization).toMatch(/^Bearer /);
  });

  it("resolutionRuns + resolutionRun expose runs, clusters and member lineage", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);

    const runs = await server.executeOperation(
      { query: `{ resolutionRuns(datasetId:"ds-1") { runId resolvedEntityCount reviewCandidateCount status } }` },
      { contextValue: ctx },
    );
    const rb = runs.body.kind === "single" ? runs.body.singleResult : null;
    expect(rb?.errors).toBeUndefined();
    expect((rb?.data?.resolutionRuns as any[])[0]).toMatchObject({ runId: "run-9", resolvedEntityCount: 12, status: "completed" });

    const detail = await server.executeOperation(
      { query: `{ resolutionRun(id:"run-9") { runId clusters { resolvedEntityId memberCount method members { memberPk } } } }` },
      { contextValue: ctx },
    );
    const db = detail.body.kind === "single" ? detail.body.singleResult : null;
    expect(db?.errors).toBeUndefined();
    const cluster = (db?.data?.resolutionRun as any).clusters[0];
    expect(cluster).toMatchObject({ resolvedEntityId: "ent:claimant:CLM-1001", memberCount: 3, method: "deterministic" });
    expect(cluster.members.map((m: any) => m.memberPk)).toEqual(["CLM-1001", "CLM-1002", "CLM-1003"]);
  });

  it("mergeCandidates lists the review queue", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ mergeCandidates(runId:"run-9") { id leftPk rightPk score status proposalId } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data?.mergeCandidates as any[])[0]).toMatchObject({
      id: "cand-1", leftPk: "CLM-1001", rightPk: "CLM-2002", score: 0.943, status: "pending", proposalId: null,
    });
  });

  it("proposeEntityMerge opens a four-eyes proposal via agent-runtime", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation {
        proposeEntityMerge(input:{ datasetId:"ds-1", runId:"run-9", candidateId:"cand-1", leftPk:"CLM-1001", rightPk:"CLM-2002", score:0.943 })
        { proposalId status executed }
      }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(body?.data?.proposeEntityMerge).toMatchObject({ proposalId: "prop-1", status: "pending", executed: false });
    const call = requests.find((r) => r.path === "/api/v1/entity-merges");
    expect(call?.body).toMatchObject({ dataset_id: "ds-1", run_id: "run-9", candidate_id: "cand-1" });
  });

  it("materializeResolvedEntities builds the governed golden-record dataset", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation {
        materializeResolvedEntities(runId:"run-9", input:{ name:"resolved_claimant", attributes:[{ column:"amount", agg:"sum" }] })
        { resolvedDatasetId resolvedDatasetUrn name rowCount columns versionNo }
      }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(body?.data?.materializeResolvedEntities).toMatchObject({
      resolvedDatasetId: "ds-resolved", name: "resolved_claimant", rowCount: 12, versionNo: 1,
    });
    const call = requests.find((r) => r.path === "/api/v1/resolution-runs/run-9/materialize");
    expect(call?.body).toMatchObject({ name: "resolved_claimant", attributes: [{ column: "amount", agg: "sum" }] });
  });
});
