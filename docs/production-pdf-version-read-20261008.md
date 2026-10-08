# Production PDF version: scoped read-only result

The Pages production object and its env_vars mapping were present (7 entries); PDF_GITHUB_COMMIT was absent. The application therefore resolves the private repository main ref rather than using a configured fixed commit. This does not prove that a particular uploaded PDF or its index row is available.

[Read-only workflow 37708828296](https://github.com/dodoxiaxia/xinzhi/actions/runs/37708828296) succeeded at source b11401444e2b198601827f808655450fea2b0c6d. The matching JSON contains only the authorized non-secret result and execution identifiers. Other environment values were neither printed nor retained. No application request, configuration write, deployment, PDF fetch or model call was performed.

The temporary diagnostic workflow and script are removed from this branch's final tree. The result was also recorded in the v14.2.13 release handoff.
