import {test as base,expect} from '@playwright/test';
export {expect};
export type {Page,TestInfo,APIRequestContext} from '@playwright/test';

/** Auto fixtures execute for every spec, unlike an imported module's hook. */
export const test=base.extend<{releaseOwnedMeeting:void}>({
  releaseOwnedMeeting:[async({page},use)=>{
    await use();
    if(page.isClosed())return;
    await page.evaluate(async()=>{
      const resources=performance.getEntriesByType('resource');
      const meeting=resources.find(entry=>new URL(entry.name).pathname==='/src/services/meetingClient.ts');
      if(!meeting)return;
      const engine=resources.find(entry=>new URL(entry.name).pathname==='/src/chat/engineInstance.ts');
      const finish=engine?(await import(engine.name)).getChatEngine().finishMeeting():Promise.resolve();
      await (await import(meeting.name)).leaveMeeting(finish);
    }).catch(()=>{});
  },{auto:true}],
});
