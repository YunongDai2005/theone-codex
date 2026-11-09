// Optional offline runner for restricted environments: only the process boundary
// is replaced. The production AppServer framing, workers, stores and MCP stay real.
import { mock, after } from 'node:test'
import { installInProcessRouter } from './fixtures/in-process-router.mjs'
installInProcessRouter({ mock, after })
