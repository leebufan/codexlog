#!/usr/bin/env node
import { main } from "../lib/codexlog.js";

process.exitCode = await main(process.argv.slice(2));
