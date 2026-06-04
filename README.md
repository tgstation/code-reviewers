# Code Reviewers

Code Reviewers is an Github action that requests code reviewers based on the files modified
in the PR and who is responsible for reviewing each of those modified files

The map of modified files to code owners is parsed from the Github Code Owners file

Code Reviewers takes the following inputs:
Name | Required | Default | Description
------------ | ------------- | ------------- | -------------
token | no | github.repository_owner |  "Github token used for Github API. Only needed to increase rate limit, may not be provided."
file | no | /.github/CODEOWNERS | "Path to the codeowners file. Relative to the repository root."
