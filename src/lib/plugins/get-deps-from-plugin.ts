import * as debugModule from 'debug';
import { legacyPlugin as pluginApi } from '@snyk/cli-interface';
import { find } from '../find-files';
import { Options, TestOptions, MonitorOptions } from '../types';
import { NoSupportedManifestsFoundError } from '../errors';
import { getMultiPluginResult } from './get-multi-plugin-result';
import { getSinglePluginResult } from './get-single-plugin-result';
import {
  detectPackageFile,
  AUTO_DETECTABLE_FILES,
  detectPackageManagerFromFile,
} from '../detect';
import analytics = require('../analytics');
import { convertSingleResultToMultiCustom } from './convert-single-splugin-res-to-multi-custom';
import { convertMultiResultToMultiCustom } from './convert-multi-plugin-res-to-multi-custom';
import { processYarnWorkspaces } from './nodejs-plugin/yarn-workspaces-parser';

const debug = debugModule('snyk-test');

const multiProjectProcessors = {
  yarnWorkspaces: {
    handler: processYarnWorkspaces,
    files: ['package.json'],
  },
  allProjects: {
    handler: getMultiPluginResult,
    files: AUTO_DETECTABLE_FILES,
  },
};

// Force getDepsFromPlugin to return scannedProjects for processing
export async function getDepsFromPlugin(
  root: string,
  options: Options & (TestOptions | MonitorOptions),
): Promise<pluginApi.MultiProjectResult> {
  let inspectRes: pluginApi.InspectResult;

  if (Object.keys(multiProjectProcessors).some((key) => options[key])) {
    const scanType = options.yarnWorkspaces ? 'yarnWorkspaces' : 'allProjects';
    const levelsDeep = options.detectionDepth;
    const ignore = options.exclude ? options.exclude.split(',') : [];
    const targetFiles = await find(
      root,
      ignore,
      multiProjectProcessors[scanType].files,
      levelsDeep,
    );
    debug(
      `auto detect manifest files, found ${targetFiles.length}`,
      targetFiles,
    );
    if (targetFiles.length === 0) {
      throw NoSupportedManifestsFoundError([root]);
    }
    inspectRes = await multiProjectProcessors[scanType].handler(
      root,
      options,
      targetFiles,
    );
    const analyticData = {
      scannedProjects: inspectRes.scannedProjects.length,
      targetFiles,
      packageManagers: targetFiles.map((file) =>
        detectPackageManagerFromFile(file),
      ),
      levelsDeep,
      ignore,
    };
    analytics.add(scanType, analyticData);
    return inspectRes;
  }

  // TODO: is this needed for the auto detect handling above?
  // don't override options.file if scanning multiple files at once
  if (!options.scanAllUnmanaged) {
    options.file = options.file || detectPackageFile(root);
  }
  if (!options.docker && !(options.file || options.packageManager)) {
    throw NoSupportedManifestsFoundError([...root]);
  }
  inspectRes = await getSinglePluginResult(root, options);

  if (!pluginApi.isMultiResult(inspectRes)) {
    if (!inspectRes.package && !inspectRes.dependencyGraph) {
      // something went wrong if both are not present...
      throw Error(
        `error getting dependencies from ${
          options.docker ? 'docker' : options.packageManager
        } ` + "plugin: neither 'package' nor 'scannedProjects' were found",
      );
    }

    return convertSingleResultToMultiCustom(inspectRes, options.packageManager);
  }

  // ----------
  // NOTE: How is projectNames used? Do we need to pull out the names
  // ----------

  // We are using "options" to store some information returned from plugin that we need to use later,
  // but don't want to send to Registry in the Payload.
  // TODO(kyegupov): decouple inspect and payload so that we don't need this hack
  const hasScannedProjects = inspectRes.scannedProjects !== undefined;
  const scannedProjectDoesNotHaveArtifacts = inspectRes.scannedProjects?.every(
    (project) => project.artifacts === undefined,
  );
  if (hasScannedProjects && scannedProjectDoesNotHaveArtifacts) {
    (options as any).projectNames = inspectRes.scannedProjects.map(
      (scannedProject) => scannedProject?.depTree?.name,
    );
  } else {
    const projectsWithDepTreeArtifacts = inspectRes.scannedProjects.filter(
      (scannedProject) =>
        scannedProject.artifacts?.some(
          (artifact) => artifact.type === 'depTree',
        ),
    );
    (options as any).projectNames = projectsWithDepTreeArtifacts.reduce<
      string[]
    >((prev, curr) => {
      // We have previously identified that this project contains a DepTree, so it can't be null.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const depTreeArtifact = curr.artifacts!.find(
        (artifact) => artifact.type === 'depTree',
      )!;
      prev.push(depTreeArtifact.data?.name);
      return prev;
    }, []);
  }
  return convertMultiResultToMultiCustom(inspectRes, options.packageManager);
}
