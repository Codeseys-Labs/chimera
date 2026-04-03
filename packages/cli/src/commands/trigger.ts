/**
 * chimera trigger — Manually trigger a CodePipeline execution
 */
import { Command } from 'commander';
import {
  CodePipelineClient,
  StartPipelineExecutionCommand,
  GetPipelineStateCommand,
} from '@aws-sdk/client-codepipeline';
import { loadWorkspaceConfig } from '../utils/workspace';

export const triggerCommand = new Command('trigger')
  .description('Manually trigger the Chimera CodePipeline')
  .option('--pipeline <name>', 'Pipeline name override')
  .option('--wait', 'Wait for pipeline to start and show initial status')
  .action(async (options) => {
    try {
      const config = loadWorkspaceConfig();
      const region = config?.aws?.region || process.env.AWS_REGION || 'us-west-2';
      const env = config?.workspace?.environment || 'dev';
      const pipelineName = options.pipeline || `chimera-deploy-${env}`;

      // Set AWS profile from chimera.toml if configured
      if (config?.aws?.profile) {
        process.env.AWS_PROFILE = config.aws.profile;
      }

      const client = new CodePipelineClient({ region });

      console.log(`Triggering pipeline: ${pipelineName}`);

      const result = await client.send(
        new StartPipelineExecutionCommand({
          name: pipelineName,
        })
      );

      console.log(`Pipeline execution started: ${result.pipelineExecutionId}`);

      if (options.wait) {
        console.log('Waiting for pipeline to initialize...');
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const state = await client.send(
          new GetPipelineStateCommand({
            name: pipelineName,
          })
        );

        console.log('\nPipeline stages:');
        for (const stage of state.stageStates || []) {
          const status = stage.latestExecution?.status || 'Unknown';
          const icon =
            status === 'InProgress'
              ? '...'
              : status === 'Succeeded'
                ? 'ok'
                : status === 'Failed'
                  ? 'FAIL'
                  : '  ';
          console.log(`  [${icon}] ${stage.stageName}: ${status}`);
        }
      }

      console.log(`\nMonitor with: chimera status`);
    } catch (error: any) {
      console.error(`Failed to trigger pipeline: ${error.message}`);
      process.exit(1);
    }
  });
