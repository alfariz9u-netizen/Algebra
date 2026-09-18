/**
 * Triad Income Strategy
 * Orchestrates OpenTask for quick API cost coverage, MoltMarket for reputation, 
 * and Colony for high-value Web3 tasks.
 */
const OpenTask = require('../../connectors/openTask');
const MoltMarket = require('../../connectors/moltMarket');
const Colony = require('../../connectors/colony');
const { addToApprovalQueue } = require('../approvalQueue');

class TriadIncomeStrategy {
    constructor(config) {
        this.openTask = new OpenTask(config);
        this.molt = new MoltMarket(config);
        this.colony = new Colony(config);
    }

    async runCycle() {
        console.log('--- Starting Triad Income Cycle ---');

        // 1. Capture Fast Cash (OpenTask)
        // Fetch tasks offering $2 or more
        const microTasks = await this.openTask.fetchOpportunities(2); 
        for (const task of microTasks) {
            if (task.autonomyLevel === 'high') {
                console.log(`Auto-executing micro-task: ${task.title}`);
                // Route task to LLM and submit directly
                // await this.openTask.claimAndSubmit(task.id, generatedOutput);
            }
        }

        // 2. Build Reputation & Secure Premium Bids (MoltMarket)
        const moltBounties = await this.molt.fetchPremiumBounties();
        for (const bounty of moltBounties) {
            // Send large tasks to the human operator (Faisal) for approval via Telegram CLI
            await addToApprovalQueue(bounty, 'MoltMarket Requires Bid Approval');
        }

        // 3. Scan for Web3 Opportunities (The Colony)
        const daoTasks = await this.colony.fetchDAOTasks('builder-dao');
        for (const daoTask of daoTasks) {
            await addToApprovalQueue(daoTask, 'High-Value DAO Task Available');
        }
        
        console.log('--- Triad Income Cycle Completed ---');
    }
}

module.exports = TriadIncomeStrategy;
