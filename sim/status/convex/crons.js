import {cronJobs} from 'convex/server'
import {internal} from './_generated/api.js'

const crons = cronJobs()
crons.interval('sample Depot build', {minutes: 1}, internal.sampling.sample)
export default crons
