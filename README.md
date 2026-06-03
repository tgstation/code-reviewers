# Code Reviewers

Code Reviewers is an Github action that requests code reviewers based on the files modified
in the PR and who is responsible for reviewing each of those modified files

The map of modified files to code owners is parsed from the Github Code Owners file

Code Reviewers takes the following inputs:
Name | Required | Default | Description
------------ | ------------- | ------------- | -------------
token | no | github.repository_owner | Token used for Github API calls.
file | no | /.github/CODEOWNERS | Full path to the code owners file
