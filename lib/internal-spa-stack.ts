import path = require('path');
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as nodeLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cmr from 'aws-cdk-lib/aws-certificatemanager';
import * as r53 from 'aws-cdk-lib/aws-route53';
import * as r53Targets from 'aws-cdk-lib/aws-route53-targets';

const hostedZoneName = '--update--me';
const domainName = '--update--me';

//pass in our hosted zone
interface IPrivateWebsiteProps extends cdk.StackProps {
	hostedZoneId: string;
}

export class InternalSpaStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: IPrivateWebsiteProps) {
		super(scope, id, props);

		if (!props || !props.hostedZoneId) {
			throw new Error('No hosted zone prop provided');
		}

		// Create a VPC with two private subnets for our ALB and VPCE
		const vpc = new ec2.Vpc(this, 'MyVPC', {
			maxAzs: 2, // Specify the desired number of Availability Zones
			subnetConfiguration: [
				{
					cidrMask: 24,
					name: 'PrivateSubnet1',
					subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
				},
			],
		});

		// Create an S3 bucket
		const s3Bucket = new s3.Bucket(this, 'MyS3Bucket', {
			bucketName: domainName,
			removalPolicy: cdk.RemovalPolicy.DESTROY, // Only for demonstration purposes, use a more appropriate removal policy in a production environment
			accessControl: s3.BucketAccessControl.PRIVATE,
		});

		// Deploy sample static website to the S3 bucket
		new s3deploy.BucketDeployment(this, 'DeployWebsite', {
			sources: [s3deploy.Source.asset('./vue-project/dist')],
			destinationBucket: s3Bucket,
		});

		// Create our VPC endpoints and retrieve their IP addresses
		const [vpcEndpoint, vpcEndpointIps] = this.createVpcEndpoint(vpc);

		// For testing - lets output the endpoints
		new cdk.CfnOutput(this, 'networkips', {
			exportName: 'networkips',
			value: JSON.stringify(vpcEndpointIps),
		});

		// Allow traffic from VPCE to the S3 Gateway Endpoint
		s3Bucket.addToResourcePolicy(
			new iam.PolicyStatement({
				actions: ['s3:GetObject'],
				resources: [s3Bucket.bucketArn, `${s3Bucket.bucketArn}/*`],
				effect: iam.Effect.ALLOW,
				principals: [new iam.AnyPrincipal()],
				conditions: {
					StringEquals: {
						'aws:sourceVpce': vpcEndpoint.vpcEndpointId,
					},
				},
			})
		);

		// create our security group allowing our VPC traffic
		const securityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
			vpc,
		});
		securityGroup.addIngressRule(
			ec2.Peer.ipv4(vpc.vpcCidrBlock),
			ec2.Port.tcp(80),
			'Allow HTTP traffic'
		);
		securityGroup.addIngressRule(
			ec2.Peer.ipv4(vpc.vpcCidrBlock),
			ec2.Port.tcp(443),
			'Allow HTTPS traffic'
		);

		// Create an Application Load Balancer
		const alb = new elbv2.ApplicationLoadBalancer(this, 'MyALB', {
			vpc,
			securityGroup,
			http2Enabled: true,
			dropInvalidHeaderFields: true,
		});

		// Add a listener for HTTP to HTTPS redirect
		alb.addListener('http', {
			protocol: elbv2.ApplicationProtocol.HTTP,
			port: 80,
			defaultAction: elbv2.ListenerAction.redirect({
				protocol: 'HTTPS',
				port: '443',
			}),
			open: false,
		});

		// Add a target group for the ALB that points to the VPCEs
		const targetGroup = new elbv2.ApplicationTargetGroup(
			this,
			'MyTargetGroup',
			{
				vpc,
				port: 443,
				protocol: elbv2.ApplicationProtocol.HTTPS,
				targetType: elbv2.TargetType.IP,
				targets: vpcEndpointIps.map((ip) => new elbv2targets.IpTarget(ip, 443)),
				healthCheck: {
					enabled: true,
					port: '443',
					healthyThresholdCount: 3,
					unhealthyThresholdCount: 3,
					healthyHttpCodes: '200,404,307,405',
				},
			}
		);

		// Retrieve the hosted zone
		const hostedZone = r53.HostedZone.fromHostedZoneAttributes(
			this,
			'hostedZone',
			{
				hostedZoneId: props.hostedZoneId,
				zoneName: hostedZoneName,
			}
		);

		// Create a listener for the HTTPS traffic
		const listener = alb.addListener('MyListener', {
			protocol: elbv2.ApplicationProtocol.HTTPS,
			port: 443,
			defaultAction: elbv2.ListenerAction.redirect({
				path: '/index.html',
			}),
			open: false,
			certificates: [
				new cmr.Certificate(this, 'Certificate', {
					domainName,
					validation: cmr.CertificateValidation.fromDns(hostedZone),
				}),
			],
		});

		// Add an action for when the static website is requested
		listener.addAction('StaticFiles', {
			priority: 100,
			conditions: [
				elbv2.ListenerCondition.pathPatterns(['index.html', 'assets/*', '*.*']),
			],
			action: elbv2.ListenerAction.forward([targetGroup]),
		});

		// Create the DNS entry for our website and point to the ALB
		new r53.ARecord(this, 'arecord', {
			zone: hostedZone,
			recordName: domainName,
			ttl: cdk.Duration.minutes(5),
			target: r53.RecordTarget.fromAlias(
				new r53Targets.LoadBalancerTarget(alb)
			),
		});
	}

	private createVpcEndpoint(
		vpc: ec2.IVpc
	): [ec2.InterfaceVpcEndpoint, string[]] {
		// Create the S3 interface endpoints
		const s3InterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'S3', {
			vpc,
			service: ec2.InterfaceVpcEndpointAwsService.S3,
			privateDnsEnabled: false,
		});

		// Create a IP lookup function for the VPCEs
		const vpcEndpointIpLookupFunction = new nodeLambda.NodejsFunction(
			this,
			'VpcEndpointIpLookupFunction',
			{
				entry: path.join('./src/handlers/vpc-endpoint-ip-lookup.ts'),
				handler: 'vpcEndpointIpLookup',
				runtime: lambda.Runtime.NODEJS_18_X,
				architecture: lambda.Architecture.ARM_64,
				timeout: cdk.Duration.seconds(15),
				initialPolicy: [
					new iam.PolicyStatement({
						sid: 'AllowDescribingResources',
						effect: iam.Effect.ALLOW,
						actions: [
							'ec2:DescribeNetworkInterfaces',
							'ec2:DescribeVpcEndpoints',
						],
						resources: ['*'],
					}),
				],
				bundling: {
					minify: true,
					sourceMap: true,
					sourceMapMode: nodeLambda.SourceMapMode.INLINE,
				},
				logRetention: logs.RetentionDays.THREE_MONTHS,
			}
		);

		/**
		 * CDK gives us a single token in an array when we ask it for the output of
		 * this custom resource, so we have to use Fn.select to pull the correct
		 * network interface IP from that array.
		 */
		const vpcEndpointIpLookup = new cdk.CustomResource(
			this,
			'VpcEndpointIpLookup',
			{
				serviceToken: vpcEndpointIpLookupFunction.functionArn,
				properties: {
					VpcEndpointId: s3InterfaceEndpoint.vpcEndpointId,
				},
				resourceType: 'Custom::VpcEndpointIpLookup',
			}
		);

		const networkInterfaceIps = vpcEndpointIpLookup
			.getAtt('NetworkInterfaceIps')
			.toStringList();

		const totalSubnets = 2;

		return [
			s3InterfaceEndpoint,
			/*
				See comment above vpcEndpointIpLookup - create an array that has one
				item for each subnet.
			*/
			Array(totalSubnets)
				.fill(null)
				.map((_, index) => cdk.Fn.select(index, networkInterfaceIps)),
		];
	}
}
