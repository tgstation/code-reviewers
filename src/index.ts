import {getInput, setFailed, info, notice} from '@actions/core'
import {context, getOctokit} from '@actions/github'
import {readFileSync} from 'fs'
import {RestEndpointMethodTypes} from '@octokit/plugin-rest-endpoint-methods'

//Maximum amount of files to process, PRs with more files will not be processed.
const FILE_LIMIT = 1000

//Returns a map of file path -> list of owners
function ParseCodeownersFile(filePath: string): Map<string, string[]> {
    const codeowners: Map<string, string[]> = new Map()

    const lines: string[] = readFileSync(filePath, {encoding: 'utf-8'}).split(
        '\n'
    )

    for (const line of lines) {
        const trimedLine = line.trim()

        if (trimedLine.startsWith('#') || trimedLine === '') {
            continue
        }

        //Split at whitespace, unless escaped
        const parsedLine: string[] = trimedLine.split(/(?<!\\)\s/)
        const path: string = parsedLine[0]

        for (var i = 1; i < parsedLine.length; i++) {
            const owner: string = parsedLine[i]

            if (codeowners.has(owner)) {
                codeowners.get(owner)?.push(path)
            } else {
                codeowners.set(owner, [path])
            }
        }
    }

    return codeowners
}

//Returns the list of owners to notify from the list of modified files
function GetOwnersWithModifiedFiles(
    codeowners: Map<string, string[]>,
    modifiedFiles: string[]
): string[] {
    const regex_files: Map<string, RegExp> = new Map()

    const owners: Set<string> = new Set()

    for (const file of modifiedFiles) {
        for (const [owner, paths] of codeowners.entries()) {
            for (const ownerPath of paths) {
                let regex_match: RegExp | undefined = regex_files.get(ownerPath)
                if (!regex_match) {
                    let regex = ownerPath
                    //No slashes at all, match any file at any level
                    const fileMode = regex.includes('/')
                    //Remove leading slash before generating Regex as modified files from PR don't start with slash aka src/code/Program.cs and not /src...
                    regex = regex.replace('/', '')

                    //Escape the input
                    regex = RegExp.escape(regex)

                    //Replace the new escaped chars with special meaning (?,*,**) with Regex that emualtes gitignore behaviour
                    regex = regex.replace('\\*\\*', '.*')
                    regex = regex.replace('\\*', '[^\/]*')
                    regex = regex.replace('\\?', '[^\/]')

                    //Match the file name anywhere in the path
                    if (fileMode) {
                        regex = `(?<=(\/|^))(${regex})(?=$)`
                    }

                    //add regex to registry to match this exact path if it appearas again in the file
                    regex_match = new RegExp(regex)
                    regex_files.set(file, regex_match)
                }

                if (file.match(regex_match)) {
                    owners.add(owner)
                }
            }
        }
    }

    return Array.from(owners)
}

async function run(): Promise<void> {
    //# Part 1: Getting all code owners based on their modified files

    try {
        const workspace_file = `${process.env.GITHUB_WORKSPACE}${getInput('file')}` //${{ github.workspace }}
        const core_owner: string = context.repo.owner //${{ github.repository_owner }}
        const core_repo: string = context.repo.repo //${{ github.repository }}
        const pull_number = context.payload.pull_request?.number //${{ github.event.pull_request.number }}
        if (!pull_number) {
            setFailed('No pull request payload found')
            return
        }

        // Log the file path being parsed
        info(`Parsing codeowner file at: ${workspace_file}`)

        // Get github client using the provided token
        const octokit: ReturnType<typeof getOctokit> = getOctokit(
            getInput('token')
        )

        let response: RestEndpointMethodTypes['pulls']['get']['response'] =
            await octokit.rest.pulls.get({
                owner: core_owner,
                repo: core_repo,
                pull_number: pull_number
            })

        if (response.data.changed_files > FILE_LIMIT) {
            setFailed(
                `PR has ${response.data.changed_files} files, which is more than the limit of ${FILE_LIMIT}. Skipping codeowner assignment.`
            )
            return
        }

        // Parse the codeowners file and get the modified files in the PR, then get the owners with modified files
        const codeowners: Map<string, string[]> =
            ParseCodeownersFile(workspace_file)

        const modifiedFiles: string[] = (
            await octokit.paginate<
                RestEndpointMethodTypes['pulls']['listFiles']['response']['data']
            >(
                octokit.rest.pulls.listFiles.endpoint.merge({
                    owner: core_owner,
                    repo: core_repo,
                    pull_number: pull_number
                })
            )
        )
            .flatMap(modified_files => modified_files)
            .map(modified_file => modified_file.filename)
        const ownersWithModifiedFiles: string[] = GetOwnersWithModifiedFiles(
            codeowners,
            modifiedFiles
        )

        // Display all code owners
        info(`Owners With Modified Files: ${ownersWithModifiedFiles.join(' ')}`)

        //# Part 2: Requesting reviews based on owners listed above

        //Remove the @ symbol at the start of every owner name
        const trimmed_owners: string[] = []
        for (const owner of ownersWithModifiedFiles) {
            trimmed_owners.push(owner.replace('@', ''))
        }

        //Remove PR author from the user list
        trimmed_owners.splice(
            trimmed_owners.indexOf(response.data.user.login),
            1
        )

        //No reviewers so stop here
        if (!trimmed_owners.length) {
            info('No reviewers to call')
            return
        }

        //Remove users that removed themselves from review
        ;(
            await octokit.paginate<
                RestEndpointMethodTypes['issues']['listEvents']['response']['data']
            >(
                octokit.rest.issues.listEvents.endpoint.merge({
                    owner: core_owner,
                    repo: core_repo,
                    issue_number: pull_number
                })
            )
        )
            .flatMap(array => array)
            .forEach(issue_event => {
                if (issue_event.event == 'review_request_removed') {
                    trimmed_owners.splice(
                        trimmed_owners.indexOf(issue_event.actor.login),
                        1
                    )
                }
            })

        //Remove Invalid users
        for (const user of trimmed_owners.toReversed()) {
            const response: RestEndpointMethodTypes['issues']['checkUserCanBeAssigned']['response'] =
                await octokit.rest.issues.checkUserCanBeAssigned({
                    owner: core_owner,
                    repo: core_repo,
                    assignee: user
                })
            if (response.status != 204) {
                notice(
                    `User ${user} cannot be requested for review, make sure they are a member of a team with read access.`
                )
                trimmed_owners.splice(trimmed_owners.indexOf(user), 1)
            }
        }

        //No reviewers so stop here
        if (!trimmed_owners.length) {
            info('No reviewers to call')
            return
        }

        //Finally notify all users for review
        await octokit.rest.pulls.requestReviewers({
            owner: core_owner,
            repo: core_repo,
            pull_number: pull_number,
            reviewers: trimmed_owners
        })
    } catch (e) {
        setFailed(`Error executing action: ${e}`)
    }
}

run()
