/*
 * Async.gs
 *
 * Manages asyncronous execution via time-based triggers.
 *
 * Note that execution normally takes 30-60s due to scheduling of the trigger.
 *
 * @see https://developers.google.com/apps-script/reference/script/clock-trigger-builder.html
 * source: https://gist.github.com/sdesalas/2972f8647897d5481fd8e01f03122805
 */

var Async = Async || {};
var asyncGlobalContext = this;

// Triggers asynchronous execution of a function (with arguments as an array)
Async.apply = function (handlerName, handlerArguments, triggerOptions) {
  var delayMs = 1;

  if (triggerOptions && 'after' in triggerOptions) {
    delayMs = triggerOptions.after;
  }

  console.log('Async.apply() - handlerName:', handlerName);
  console.log('Async.apply() - time_after:', delayMs);

  var trigger = ScriptApp.newTrigger('Async_handler').timeBased().after(delayMs).create();

  CacheService.getScriptCache().put(
    String(trigger.getUniqueId()),
    JSON.stringify({ handlerName: handlerName, args: handlerArguments }),
    21600,
  );

  return {
    triggerUid: trigger.getUniqueId(),
    source: String(trigger.getTriggerSource()),
    eventType: String(trigger.getEventType()),
    handlerName: handlerName,
    args: handlerArguments,
  };
};

function Async_handler(triggerEvent) {
  var triggerUid = triggerEvent && triggerEvent.triggerUid;
  var cachedInvocation = CacheService.getScriptCache().get(triggerUid);

  if (cachedInvocation) {
    try {
      var invocation = JSON.parse(cachedInvocation);
      var handlerName = invocation && invocation.handlerName;
      var handlerArguments = invocation && invocation.args;

      console.log('Async_handler() handlerName', handlerName);

      if (handlerName) {
        var handlerContext;
        var handlerFunction = handlerName.split('.').reduce(function (parent, propertyName) {
          handlerContext = parent;

          return parent && parent[propertyName];
        }, asyncGlobalContext);

        if (!handlerFunction || !handlerFunction.apply) {
          throw 'Handler `' + handlerName + '` does not exist! Exiting..';
        }

        // Execute with arguments
        handlerFunction.apply(handlerContext, handlerArguments || []);
      }
    } catch (error) {
      console.error(error);
    }
  }

  // Delete the trigger, it only needs to be executed once
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getUniqueId() === triggerUid) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
