import {getInput, setFailed, info, notice} from '@actions/core'
import {context, getOctokit} from '@actions/github'
import {readFileSync} from 'fs'
import {PaginatingEndpoints} from '@octokit/plugin-paginate-rest'

//Maximum amount of files to process per page.
const FILES_PER_PAGE = 300

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
    modifiedFiles: string[],
    regex_files: Map<string, RegExp>,
    owners: Set<string>
): void {
    for (const file of modifiedFiles) {
        //we literarly have no owners to parse so drop
        if (owners.size == codeowners.size) {
            return
        }

        for (const [owner, paths] of codeowners.entries()) {
            //don't parse the same owner twice
            if (owners.has(owner)) {
                continue
            }

            //check if the owner owns this file
            for (const ownerPath of paths) {
                let regex_match: RegExp | undefined = regex_files.get(ownerPath)
                if (!regex_match) {
                    let regex = ownerPath
                    //No slashes at all, match any file at any level
                    const fileMode = !regex.includes('/')
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
                    regex_files.set(ownerPath, regex_match)
                }

                if (file.match(regex_match)) {
                    owners.add(owner)
                }
            }
        }
    }
}

async function run(): Promise<void> {
    //# Part 1: Getting all code owners based on their modified files

    const pull_request = context.payload.pull_request
    if (!pull_request) {
        return
    }

    try {
        const workspace_file = `${process.env.GITHUB_WORKSPACE}${getInput('file')}` //${{ github.workspace }}
        const core_owner: string = context.repo.owner //${{ github.repository_owner }}
        const core_repo: string = context.repo.repo //${{ github.repository }}
        const pull_number = pull_request.number //${{ github.event.pull_request.number }}
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

        // Parse the codeowners file and get the modified files in the PR, then get the owners with modified files
        const codeowners: Map<string, string[]> =
            ParseCodeownersFile(workspace_file)

        // Get all codeowners of modified files. We process each page of files and push the results onto the final list
        const modifiedFilesIterator = octokit.paginate.iterator<
            PaginatingEndpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/files']['response']['data']
        >(
            octokit.rest.pulls.listFiles.endpoint.merge<
                PaginatingEndpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/files']['parameters']
            >({
                owner: core_owner,
                repo: core_repo,
                pull_number: pull_number,
                per_page: FILES_PER_PAGE
            })
        )

        // Push results per page onto the final array
        const ownerPathRegexMap: Map<string, RegExp> = new Map()
        const ownersWithModifiedFiles: Set<string> = new Set()
        for await (const page of modifiedFilesIterator) {
            GetOwnersWithModifiedFiles(
                codeowners,
                page.data
                    .flatMap(files => files)
                    .map(modified_file => modified_file.filename),
                ownerPathRegexMap,
                ownersWithModifiedFiles
            )
        }

        // Display all code owners
        info(
            `Owners With Modified Files: ${ownersWithModifiedFiles.values().toArray().join(' ')}`
        )

        //# Part 2: Requesting reviews based on owners listed above
        const trimmed_owners: string[] = []

        //Remove the @ symbol at the start of every owner name
        for (const owner of ownersWithModifiedFiles) {
            trimmed_owners.push(owner.replace('@', ''))
        }

        //Remove PR author from the user list
        const index = trimmed_owners.indexOf(pull_request.user.login)
        if (index >= 0) {
            trimmed_owners.splice(index, 1)
        }

        //Remove Invalid users
        for (const user of trimmed_owners.toReversed()) {
            try {
                await octokit.rest.issues.checkUserCanBeAssigned({
                    owner: core_owner,
                    repo: core_repo,
                    assignee: user
                })
            } catch {
                notice(
                    `User ${user}: Cannot be requested for review, make sure they are a member of a team with read access.`
                )
                trimmed_owners.splice(trimmed_owners.indexOf(user), 1)
            }
        }

        //Remove review requests from users no longer impacted
        const currentlyRequested: string[] = (
            pull_request.requested_reviewers ?? []
        ).map((r: {login: string}) => r.login)
        const toRemove = currentlyRequested.filter(
            r => !trimmed_owners.includes(r) && codeowners.has('@' + r)
        )
        if (toRemove.length) {
            info(`Removing review requests from: ${toRemove.join(' ')}`)
            await octokit.rest.pulls.removeRequestedReviewers({
                owner: core_owner,
                repo: core_repo,
                pull_number: pull_number,
                reviewers: toRemove
            })
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
