#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InternalSpaStack } from '../lib/internal-spa-stack';

const app = new cdk.App();
new InternalSpaStack(app, 'InternalSpaStack', {
	hostedZoneId: '--update--me',
});
