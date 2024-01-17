#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SfHttpStack } from '../lib/sf-http-stack';

const app = new cdk.App();
new SfHttpStack(app, 'LicenseManagerStack', {});
