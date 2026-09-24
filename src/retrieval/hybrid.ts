import { searchPassagesFullText } from "./repository";
import { searchPassagesSemantic } from "./semanticRepository";
import type { Retriever, SearchResult } from "./types";

/** Standard Reciprocal Rank Fusion constant. Fixed for the experiment; not tuned. */
export const RRF_K = 60;
/** How many candidates each retriever contributes before fusion. */
export const HYBRID_CANDIDATE_DEPTH = 50;

export interface FusedRank {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: each ranking contributes 1 / (k + rank) for every
 * id it contains (rank starts at 1); ids missing from a ranking get nothing
 * from it. Ties are broken by id so the order is deterministic.
 */
export function reciprocalRankFusion(rankings: string[][], k = RRF_K): FusedRank[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Hybrid retrieval: fuses the top lexical and semantic candidates with equal
 * weight. Each fused result keeps the lexical result object when the passage
 * was found lexically (for its highlighted snippet); `score` is the RRF score.
 */
export const searchPassagesHybrid: Retriever = async (params) => {
  const candidateParams = { ...params, limit: HYBRID_CANDIDATE_DEPTH };
  const [lexical, semantic] = await Promise.all([
    searchPassagesFullText(candidateParams),
    searchPassagesSemantic(candidateParams),
  ]);

  const byId = new Map<string, SearchResult>();
  for (const result of [...semantic, ...lexical]) byId.set(result.passage.id, result);

  const ids = (results: SearchResult[]) => results.map((result) => result.passage.id);
  return reciprocalRankFusion([ids(lexical), ids(semantic)])
    .slice(0, params.limit)
    .map(({ id, score }) => ({ ...byId.get(id)!, score }));
};
