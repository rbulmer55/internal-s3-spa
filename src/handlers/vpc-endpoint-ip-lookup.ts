import axios, { AxiosResponse } from 'axios';
import {
	DescribeNetworkInterfacesCommand,
	DescribeVpcEndpointsCommand,
	EC2Client,
} from '@aws-sdk/client-ec2';

export interface ICustomResourceProperties {
	ServiceToken: string;
	VpcEndpointId: string;
}

export interface IEvent {
	RequestType: string;
	ServiceToken: string;
	ResponseURL: string;
	StackId: string;
	RequestId: string;
	LogicalResourceId: string;
	PhysicalResourceId?: string;
	ResourceType: string;
	ResourceProperties: ICustomResourceProperties;
}
const client = new EC2Client();

async function getNetworkInterfaceIds(
	client: EC2Client,
	vpcEndpointId: string
) {
	const response = await client.send(
		new DescribeVpcEndpointsCommand({
			VpcEndpointIds: [vpcEndpointId],
		})
	);

	if (!response.VpcEndpoints || response.VpcEndpoints.length !== 1) {
		throw new Error(
			`Expected to find 1 VPC Endpoint with ID ${vpcEndpointId}, found ${JSON.stringify(
				response.VpcEndpoints
			)}`
		);
	}

	const networkInterfaceIds = response.VpcEndpoints[0].NetworkInterfaceIds;

	if (!networkInterfaceIds) {
		throw new Error(
			`Network interface IDs not returned for VPC Endpoint ${vpcEndpointId}: ${JSON.stringify(
				response.VpcEndpoints
			)}`
		);
	}

	return networkInterfaceIds;
}

async function getNetworkInterfaceIps(
	client: EC2Client,
	networkInterfaceIds: string[]
) {
	const networkInterfaces = await client.send(
		new DescribeNetworkInterfacesCommand({
			NetworkInterfaceIds: networkInterfaceIds,
		})
	);

	if (
		!networkInterfaces.NetworkInterfaces ||
		networkInterfaces.NetworkInterfaces.length !== networkInterfaceIds.length
	) {
		throw new Error(
			`Expected to get ${
				networkInterfaceIds.length
			} network interfaces, got ${JSON.stringify(
				networkInterfaces.NetworkInterfaces
			)}`
		);
	}

	return networkInterfaces.NetworkInterfaces.map((networkInterface) => {
		if (!networkInterface.PrivateIpAddress) {
			throw new Error(
				`Network interface ${
					networkInterface.NetworkInterfaceId
				} did not have a private IP: ${JSON.stringify(networkInterface)}`
			);
		}

		return networkInterface.PrivateIpAddress;
	});
}

export const vpcEndpointIpLookup = async (event: IEvent, context: any) => {
	console.log(event);
	try {
		const vpcEndpointId = event.ResourceProperties.VpcEndpointId;

		if (event.RequestType === 'Create' || event.RequestType === 'Update') {
			console.log('Fetching VPC Endpoint IPs for', vpcEndpointId);

			const networkInterfaceIds = await getNetworkInterfaceIds(
				client,
				vpcEndpointId
			);

			console.log('Got network interface IDs', networkInterfaceIds.join(', '));

			const networkInterfaceIps = await getNetworkInterfaceIps(
				client,
				networkInterfaceIds
			);

			console.log('Got IPs', networkInterfaceIps.join(', '));

			event.PhysicalResourceId = vpcEndpointId;

			await cfnResponse(event, context, 'SUCCESS', {
				NetworkInterfaceIps: networkInterfaceIps,
			});
		} else {
			console.log(
				'Not removing any tags - we are assuming the alarm itself is being deleted.'
			);

			event.PhysicalResourceId = void 0;

			await cfnResponse(event, context, 'SUCCESS');
		}
	} catch (err) {
		console.log(err);
		await cfnResponse(event, context, 'FAILED', { message: err });
		throw err;
	}
};

async function cfnResponse(
	event: IEvent,
	context: { logGroupName: string; logStreamName: string } & Record<
		string,
		unknown
	>,
	status: string,
	customData?: { NetworkInterfaceIps?: string[]; message?: unknown }
): Promise<AxiosResponse> {
	const responseData = JSON.stringify({
		Status: status,
		StackId: event.StackId,
		RequestId: event.RequestId,
		LogicalResourceId: event.LogicalResourceId,
		PhysicalResourceId: event.PhysicalResourceId || context.logStreamName,
		Reason:
			'See the details in CloudWatch Log Group: ' +
			context.logGroupName +
			' Log Stream: ' +
			context.logStreamName,
		Data: customData,
	});

	const responseOptions = {
		headers: {
			'Content-Type': '',
			'Content-Length': responseData.length,
		},
	};

	console.log(event);
	console.log(responseData);

	return await axios.put(event.ResponseURL, responseData, responseOptions);
}
