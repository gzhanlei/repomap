export { analyzeSource, analyzeSources, type AnalyzeOptions } from "./core/analyze.js";
export { parseGitHubRepository, resolveGitHubRevision, type GitHubRepositoryRef } from "./core/github/repository.js";
export { loadGitHubRepositorySources, type GitHubSourceOptions } from "./core/github/archive.js";
export { loadLocalRepositorySources, verifyLocalGitRevision, defaultRepositorySourceBudgets, type RepositorySourceBudgets } from "./core/source/local.js";
export { prepareArchify } from "./core/archify-runtime.js";
