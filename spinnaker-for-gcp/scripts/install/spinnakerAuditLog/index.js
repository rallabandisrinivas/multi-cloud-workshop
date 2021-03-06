const config = require('./config.json');
const moment = require('moment-timezone');
const {Logging} = require('@google-cloud/logging');

const logging = new Logging({
  projectId: config.PROJECT_ID,
  keyFilename: config.CREDENTIALS_PATH
});

/**
 * Logs Spinnaker events to Stackdriver Logging.
 *
 * @param {!Object} req Cloud Function request context.
 * @param {!Object} res Cloud Function response context.
 */
exports.spinnaker1AuditLog = function spinnakerAuditLog (req, res) {
  log('req.body.payload=' + JSON.stringify(req.body.payload), null, null, 'DEBUG');

  try {
    verifyWebhook(req.get('authorization') || '');

    if (req.body.eventName !== 'spinnaker_events' || req.body.payload === undefined) {
      res.status(400).send('Spinnaker audit log request body is malformed.');
    } else {
      var content = req.body.payload.content;
      var eventSource = req.body.payload.details.source;
      var eventType = req.body.payload.details.type;
      var execution = content.execution;
      var context = content.context;
      var stageDetails = (execution && execution.stages && execution.stages.length > 0) ? execution.stages.find(stage => stage.status === 'RUNNING') : {};
      var user = execution && execution.authentication && execution.authentication.user ? execution.authentication.user : 'n/a';

      if (execution && execution.trigger) {
        if (execution.trigger.runAsUser) {
          user = execution.trigger.runAsUser;
        } else if (execution.trigger.user) {
          user = execution.trigger.user;
        }
      }

      var creationTimestamp = moment.tz(Number(req.body.payload.details.created), config.TIMEZONE).format('ddd, DD MMM YYYY HH:mm:ss z');

      var reasonSegment;

      if (eventSource === 'igor') {
        if (eventType === 'build') {
          var lastBuild = content.project.lastBuild;
          var jenkinsTimestamp = moment.tz(Number(lastBuild.timestamp), config.TIMEZONE).format('ddd, DD MMM YYYY HH:mm:ss z');

          if (lastBuild.result === 'SUCCESS') {
            log('Jenkins project ' + content.project.name + ' successfully completed build #' + lastBuild.number + ' at ' + jenkinsTimestamp + '.', null, null);
          } else {
            log('Jenkins project ' + content.project.name + ' completed build #' + lastBuild.number + ' with status ' + lastBuild.result + ' at ' + jenkinsTimestamp + '.', null, null, 'ERROR');
          }
        } else if (eventType === 'docker') {
          log('Docker tag ' + content.tag + ' was pushed to repository ' + content.repository + ' in registry ' + content.registry + ' at ' + creationTimestamp + '.', null, null);
        }
      } else if (eventType === 'git') {
        log('Received webhook for project ' + content.slug + ' in org ' + content.repoProject + ' from ' + eventSource + ' at commit ' + content.hash + ' on branch ' + content.branch + ' at ' + creationTimestamp + '.', null, null);
      } else if (eventType === 'orca:stage:starting' && !stageDetails.syntheticStageOwner) {
        if (!content.standalone) {
          log('User ' + user + ' executed operation ' + stageDetails.name + ' (of type ' + stageDetails.type + ') via pipeline ' + execution.name + ' of application ' + execution.application + ' at ' + creationTimestamp + '.', execution.application, execution.name);
        } else if (stageDetails.type === 'savePipeline') {
          log('User ' + user + ' executed operation (' + execution.description + ') at ' + creationTimestamp + '.', null, null);
        } else {
          reasonSegment = context.reason ? ' for reason "' + context.reason + '"' : '';

          log('User ' + user + ' executed ad-hoc operation ' + execution.stages[0].type + ' (' + execution.description + ')' + reasonSegment + ' at ' + creationTimestamp + '.', null, null);
        }
      } else if (eventType === 'orca:pipeline:starting') {
        var parametersSegment = execution.trigger.parameters ? ' (with parameters ' + JSON.stringify(execution.trigger.parameters) + ')' : '';

        log('User ' + user + ' executed pipeline ' + execution.name + ' of application ' + execution.application + ' via ' + execution.trigger.type + ' trigger' + parametersSegment + ' at ' + creationTimestamp + '.', execution.application, execution.name);
      } else if (eventType === 'orca:pipeline:failed' && execution.canceled) {
        var cancellationUser = execution.canceledBy ? execution.canceledBy : null;

        if (cancellationUser) {
          reasonSegment = execution.cancellationReason ? ' for reason "' + execution.cancellationReason + '"' : '';

          log('User ' + cancellationUser + ' canceled pipeline ' + execution.name + ' of application ' + execution.application + reasonSegment + ' at ' + creationTimestamp + '.', execution.application, execution.name, 'WARNING');
        } else {
          log('Pipeline ' + execution.name + ' of application ' + execution.application + ' failed at ' + creationTimestamp + '.', execution.application, execution.name, 'ERROR');
        }
      } else if (eventType === 'orca:pipeline:complete') {
        log('Pipeline ' + execution.name + ' of application ' + execution.application + ' completed at ' + creationTimestamp + '.', execution.application, execution.name);
      } else if (!content.standalone && context && stageDetails && stageDetails.type === 'manualJudgment' && eventType === 'orca:task:failed') {
        var judgmentInputSegment = context.judgmentInput ? ' (judgment "' + context.judgmentInput + '" was selected)' : '';

        log('User ' + context.lastModifiedBy + ' judged stage ' + stageDetails.name + ' of pipeline ' + execution.name + ' of application ' + execution.application + ' to stop' + judgmentInputSegment + ' at ' + creationTimestamp + '.', execution.application, execution.name, 'WARNING');
      } else if (!content.standalone && context && stageDetails && stageDetails.type === 'manualJudgment' && eventType === 'orca:task:complete') {
        var judgmentInputSegment = context.judgmentInput ? ' (judgment "' + context.judgmentInput + '" was selected)' : '';

        log('User ' + context.lastModifiedBy + ' judged stage ' + stageDetails.name + ' of pipeline ' + execution.name + ' of application ' + execution.application + ' to continue' + judgmentInputSegment + ' at ' + creationTimestamp + '.');
      } else if (eventType === 'orca:task:failed') {
        var failureReasonSegment = context.exception && context.exception.details && context.exception.details.errors && context.exception.details.errors[0] ? ' due to ' + JSON.stringify(context.exception.details.errors) : '';

        if (!content.standalone) {
          log('Operation ' + stageDetails.name + ' (of type ' + stageDetails.type + ') of pipeline ' + execution.name + ' of application ' + execution.application + ' failed' + failureReasonSegment + ' at ' + creationTimestamp + '.', execution.application, execution.name, 'ERROR');
        } else {
          log('Ad-hoc operation ' + stageDetails.type + ' failed' + failureReasonSegment + ' at ' + creationTimestamp + '.', null, null, 'ERROR');
        }
      }

      res.status(200).send('Success: ' + req.body.eventName);
    }
  } catch (err) {
    log(err, 'ERROR');
    res.status(err.code || 500).send(err);
  }
};

/**
 * Verify that the webhook request came from spinnaker/echo.
 *
 * @param {string} authorization The authorization header of the request, e.g. "Basic ZmdvOhJhcg=="
 */
function verifyWebhook (authorization) {
  const basicAuth = new Buffer(authorization.replace('Basic ', ''), 'base64').toString();
  const parts = basicAuth.split(':');

  if (parts[0] !== config.USERNAME || parts[1] !== config.PASSWORD) {
    const error = new Error('Invalid credentials');
    error.code = 401;
    throw error;
  }
}

/**
 * Writes message to StackDriver with specified severity.
 * 
 * @param {string} message - The message to log to StackDriver logging.
 * @param {('ALERT', 'CRITICAL', 'DEBUG', 'EMERGENCY', 'ERROR', 'INFO', 'NOTICE', 'WARNING', 'WRITE')} severity - The 
 * severity of the logged message. Defaults to 'INFO'.
 */
function log(message, application, pipeline, severity = 'INFO') {
  var log = logging.log(config.AUDIT_LOG_NAME);
  var metadata = {resource: {type: 'cloud_function'}, severity: severity};
  var jsonPayload = {message: message};
  if (application) {
    jsonPayload.application = application;
  }
  if (pipeline) {
    jsonPayload.pipeline = pipeline;
  }
  var entry = log.entry(metadata, jsonPayload);

  log.write(entry);
}
